import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import type {
  AppState, CopilotModel, CopilotQuota, GithubUser, ImageGenRequest, ImageGenResult, LoginState, Settings,
} from "../shared/types";
import { Store, type SecretCodec } from "./store";
import { RequestLog } from "./logger";
import {
  CopilotTokenManager, fetchCopilotQuota, fetchGithubUser, pollDeviceFlow, startDeviceFlow, NotLoggedInError, type FetchLike,
} from "./auth";
import { CopilotClient } from "./copilot";
import { ProxyServer } from "./server";
import { ENDPOINT } from "./constants";
import { resolveModel } from "./models";
import * as integ from "./integrations";
import { L, setLang, resolveLang, getLang } from "./i18n";

export interface AppCoreOptions {
  dataDir: string;
  version: string;
  codec?: SecretCodec;
  /** 系统语言（如 zh-CN / en-US），用于 language=auto */
  systemLocale?: string;
  /** 自定义 fetch（Electron 下可传入 net.fetch 以使用系统代理） */
  fetch?: (useSystemProxy: boolean) => FetchLike;
}

const MODELS_TTL = 10 * 60_000;

/** 探测端口是否可监听（被占用 / 系统保留时抛出可读错误） */
export function probePort(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (e: any) => {
      reject(new Error(
        e?.code === "EADDRINUSE" ? L(`端口 ${port} 已被其他程序占用，请换一个端口`, `Port ${port} is already in use by another program. Choose a different port.`) :
        e?.code === "EACCES" ? L(`端口 ${port} 被系统保留或无权限使用，请换一个端口`, `Port ${port} is reserved by the system or not permitted. Choose a different port.`) :
        L(`无法使用端口 ${port}：${e?.message ?? e}`, `Cannot use port ${port}: ${e?.message ?? e}`),
      ));
    });
    srv.listen(port, host, () => srv.close(() => resolve()));
  });
}

export class AppCore extends EventEmitter {
  readonly store: Store;
  readonly log = new RequestLog();
  readonly tokens: CopilotTokenManager;
  readonly client: CopilotClient;
  readonly server: ProxyServer;

  private models: CopilotModel[] = [];
  private modelsUpdatedAt?: number;
  private modelsError?: string;
  private modelsInflight?: Promise<CopilotModel[]>;
  private quota?: CopilotQuota;
  private login: LoginState = { status: "idle" };
  private loginAbort?: AbortController;
  private proxyError?: string;
  private proxyStartedAt?: number;
  private emitTimer?: NodeJS.Timeout;

  constructor(private opts: AppCoreOptions) {
    super();
    this.store = new Store(opts.dataDir, opts.codec);
    this.applyLang();
    const fetchFn = () => (opts.fetch ? opts.fetch(this.settings.useSystemProxy) : (globalThis.fetch as FetchLike));
    const adv = () => this.settings.advanced;
    this.tokens = new CopilotTokenManager(fetchFn, adv, () => this.store.getGithubToken());
    this.client = new CopilotClient(this.tokens, fetchFn, adv);
    this.server = new ProxyServer({
      client: this.client,
      getModels: () => this.getModels(),
      settings: () => this.settings,
      log: this.log,
    });
    this.log.on("entry", () => this.emitState());
  }

  private get fetchFn(): FetchLike {
    return this.opts.fetch ? this.opts.fetch(this.settings.useSystemProxy) : (globalThis.fetch as FetchLike);
  }

  get settings(): Settings { return this.store.settings; }

  private applyLang() { setLang(resolveLang(this.settings.language, this.opts.systemLocale)); }
  get loggedIn(): boolean { return !!this.store.getGithubToken(); }

  /** 本地代理对外地址（不含 /v1） */
  baseUrl(): string {
    const s = this.settings;
    const host = s.host === "0.0.0.0" || s.host === "::" || !s.host ? "127.0.0.1" : s.host;
    return `http://${host}:${s.port}`;
  }

  async init() {
    if (this.settings.autoStartProxy) {
      await this.startProxy().catch(() => {});
    }
    if (this.loggedIn) {
      this.refreshModels().catch(() => {});
      this.refreshAccount().catch(() => {});
    }
  }

  // ------------------------------------------------------------------ state

  state(): AppState {
    const tokenInfo = this.tokens.info;
    return {
      version: this.opts.version,
      lang: getLang(),
      loggedIn: this.loggedIn,
      user: this.store.getUser(),
      quota: this.quota,
      apiBase: tokenInfo?.apiBase,
      tokenExpiresAt: tokenInfo?.expiresAt,
      login: this.login,
      proxy: { running: this.server.running, url: this.baseUrl(), error: this.proxyError, startedAt: this.proxyStartedAt },
      models: this.models.map(({ raw, ...m }) => m),
      modelsUpdatedAt: this.modelsUpdatedAt,
      modelsError: this.modelsError,
      settings: this.settings,
      integrations: {
        claude: integ.claudeStatus(this.baseUrl()),
        codex: integ.codexStatus(this.settings.codex.providerId, this.baseUrl() + "/v1"),
      },
      stats: { ...this.log.stats },
    };
  }

  emitState() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit("state", this.state());
    }, 50);
  }

  // ------------------------------------------------------------------ login

  async startLogin(): Promise<LoginState> {
    this.cancelLogin();
    const ctl = new AbortController();
    this.loginAbort = ctl;
    const flow = await startDeviceFlow(this.fetchFn, this.settings.advanced);
    const { deviceCode, ...info } = flow;
    this.login = { status: "pending", info };
    this.emitState();
    (async () => {
      try {
        const token = await pollDeviceFlow(this.fetchFn, this.settings.advanced, deviceCode, info.interval, info.expiresAt, ctl.signal);
        let user: GithubUser | undefined;
        try { user = await fetchGithubUser(this.fetchFn, this.settings.advanced, token); } catch {}
        this.store.setAuth(token, user);
        this.tokens.reset();
        // 验证 Copilot 订阅
        await this.tokens.get(true);
        this.login = { status: "success" };
        this.emitState();
        await Promise.allSettled([this.refreshModels(), this.refreshAccount()]);
        if (this.settings.autoStartProxy && !this.server.running) await this.startProxy().catch(() => {});
      } catch (e: any) {
        if (ctl.signal.aborted) return;
        this.login = { status: "error", message: e?.message ?? String(e) };
      } finally {
        if (this.loginAbort === ctl) this.loginAbort = undefined;
        this.emitState();
      }
    })();
    return this.login;
  }

  cancelLogin() {
    this.loginAbort?.abort();
    this.loginAbort = undefined;
    if (this.login.status === "pending") this.login = { status: "idle" };
    this.emitState();
  }

  logout() {
    this.cancelLogin();
    this.store.clearAuth();
    this.tokens.reset();
    this.models = [];
    this.modelsUpdatedAt = undefined;
    this.quota = undefined;
    this.login = { status: "idle" };
    this.emitState();
  }

  async refreshAccount() {
    const token = this.store.getGithubToken();
    if (!token) return;
    const adv = this.settings.advanced;
    const [user, quota] = await Promise.all([
      fetchGithubUser(this.fetchFn, adv, token).catch(() => undefined),
      fetchCopilotQuota(this.fetchFn, adv, token),
    ]);
    if (user) {
      // 头像在主进程下载并转成 data URL：不受渲染进程 CSP / 代理影响，离线也能显示缓存
      const prev = this.store.getUser();
      user.avatarDataUrl = prev?.avatarUrl === user.avatarUrl ? prev?.avatarDataUrl : undefined;
      if (user.avatarUrl && !user.avatarDataUrl) user.avatarDataUrl = await this.fetchAvatar(user.avatarUrl);
      this.store.setUser(user);
    }
    this.quota = quota;
    this.emitState();
  }

  private async fetchAvatar(url: string): Promise<string | undefined> {
    try {
      const u = new URL(url);
      u.searchParams.set("s", "96");
      const res = await this.fetchFn(u.toString(), { headers: { accept: "image/*" } });
      if (!res.ok) return undefined;
      const type = (res.headers.get("content-type") ?? "image/png").split(";")[0];
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 512 * 1024) return undefined;
      return `data:${type};base64,${buf.toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------ models

  async refreshModels(): Promise<CopilotModel[]> {
    if (!this.loggedIn) throw new NotLoggedInError();
    if (!this.modelsInflight) {
      this.modelsInflight = this.client
        .listModels()
        .then((m) => {
          this.models = m;
          this.modelsUpdatedAt = Date.now();
          this.modelsError = undefined;
          this.autofillDefaults();
          return m;
        })
        .catch((e) => {
          this.modelsError = e?.message ?? String(e);
          throw e;
        })
        .finally(() => {
          this.modelsInflight = undefined;
          this.emitState();
        });
    }
    return this.modelsInflight;
  }

  async getModels(): Promise<CopilotModel[]> {
    const stale = !this.modelsUpdatedAt || Date.now() - this.modelsUpdatedAt > MODELS_TTL;
    if (this.models.length === 0) {
      try { return await this.refreshModels(); } catch (e) { if (e instanceof NotLoggedInError) throw e; return this.models; }
    }
    if (stale) this.refreshModels().catch(() => {});
    return this.models;
  }

  /** 首次拿到模型列表时，自动填充合理的默认选择 */
  private autofillDefaults() {
    const chat = this.models.filter((m) => m.kind === "chat" && m.policyState !== "disabled");
    const pick = (...patterns: RegExp[]) => {
      for (const p of patterns) {
        const m = chat.filter((x) => p.test(x.id)).sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
        if (m) return m.id;
      }
      return chat[0]?.id ?? "";
    };
    const s = this.settings;
    const patch: any = {};
    if (!s.defaultModel) patch.defaultModel = pick(/^claude-sonnet/, /^gpt-5/, /^gpt-4\.1/);
    if (!s.claude.model) patch.claude = { ...(patch.claude ?? {}), model: pick(/^claude-sonnet/, /^claude-opus/, /^gpt-5/) };
    if (!s.claude.opusModel) patch.claude = { ...(patch.claude ?? {}), opusModel: pick(/^claude-opus/, /^claude-sonnet/) };
    if (!s.claude.smallModel) patch.claude = { ...(patch.claude ?? {}), smallModel: pick(/^claude-haiku/, /mini/, /^gpt-4\.1/, /^gpt-4o/) };
    if (!s.codex.model) patch.codex = { model: pick(/codex/, /^gpt-5/, /^claude-sonnet/) };
    if (!s.imageModel) {
      const img = this.models.find((m) => m.kind === "image" && m.policyState !== "disabled");
      if (img) patch.imageModel = img.id;
    }
    if (Object.keys(patch).length) this.store.updateSettings(patch);
  }

  async enableModel(id: string) {
    await this.client.enableModel(id);
    await this.refreshModels();
  }

  // ------------------------------------------------------------------ proxy

  async startProxy(): Promise<string> {
    try {
      const url = await this.server.start(this.settings.host, this.settings.port);
      this.proxyError = undefined;
      this.proxyStartedAt = Date.now();
      return url;
    } catch (e: any) {
      this.proxyError = e?.message ?? String(e);
      throw e;
    } finally {
      this.emitState();
    }
  }

  async stopProxy() {
    await this.server.stop();
    this.proxyStartedAt = undefined;
    this.proxyError = undefined;
    this.emitState();
  }

  async updateSettings(patch: Partial<Settings> | any): Promise<Settings> {
    const before = this.settings;
    const prevHost = before.host, prevPort = before.port, prevKey = before.apiKey;
    const nextHost = patch?.host ?? prevHost;
    const nextPort = patch?.port ?? prevPort;
    const addrChanged = nextHost !== prevHost || nextPort !== prevPort;
    // 地址变化前先探测新端口：被占用则拒绝修改，原服务保持运行
    if (addrChanged) await probePort(nextHost, nextPort);
    const wasRunning = this.server.running;
    const hadError = !!this.proxyError;
    const s = this.store.updateSettings(patch);
    this.applyLang();
    if (addrChanged && (wasRunning || hadError)) {
      await this.startProxy().catch(() => {});
    }
    // 端口或密钥变化后，已应用的集成需要同步
    if (s.port !== prevPort || s.host !== prevHost || s.apiKey !== prevKey) {
      const oldBase = `http://${prevHost === "0.0.0.0" ? "127.0.0.1" : prevHost}:${prevPort}`;
      try { if (integ.claudeStatus(oldBase).applied) this.applyClaude(); } catch {}
      try { if (integ.codexStatus(s.codex.providerId, oldBase + "/v1").applied) this.applyCodex(); } catch {}
    }
    this.emitState();
    return s;
  }

  // ------------------------------------------------------------------ integrations

  applyClaude(): string {
    const s = this.settings;
    const { file, backup } = integ.applyClaude(
      {
        baseUrl: this.baseUrl(),
        authToken: s.apiKey || "copilot-proxy",
        model: s.claude.model || s.defaultModel,
        opusModel: s.claude.opusModel,
        smallModel: s.claude.smallModel,
        disableNonEssentialTraffic: s.claude.disableNonEssentialTraffic,
      },
      this.store.getIntegrationBackup("claude"),
    );
    this.store.setIntegrationBackup("claude", backup);
    this.emitState();
    return file;
  }

  restoreClaude(): string {
    const file = integ.restoreClaude(this.store.getIntegrationBackup("claude"), this.baseUrl());
    this.store.setIntegrationBackup("claude", undefined);
    this.emitState();
    return file;
  }

  applyCodex(): string {
    const s = this.settings;
    const model = s.codex.model || s.defaultModel;
    const info = this.models.find((m) => m.id === model);
    const { file, backup } = integ.applyCodex(
      {
        providerId: s.codex.providerId,
        baseUrl: this.baseUrl() + "/v1",
        apiKey: s.apiKey || undefined,
        model,
        reasoningEffort: s.codex.reasoningEffort || undefined,
        contextWindow: info?.contextWindow,
        maxOutputTokens: info?.maxOutputTokens,
      },
      this.store.getIntegrationBackup("codex"),
    );
    this.store.setIntegrationBackup("codex", backup);
    this.emitState();
    return file;
  }

  restoreCodex(): string {
    const file = integ.restoreCodex(this.store.getIntegrationBackup("codex"), this.settings.codex.providerId);
    this.store.setIntegrationBackup("codex", undefined);
    this.emitState();
    return file;
  }

  // ------------------------------------------------------------------ tools

  /** 直接调用 Copilot 生图接口（不经过本地 HTTP），用于 UI 中的生图面板 */
  async generateImage(req: ImageGenRequest, saveDir?: string): Promise<ImageGenResult> {
    const started = Date.now();
    const models = await this.getModels();
    const r = resolveModel(req.model || this.settings.imageModel, "image", models, this.settings);
    if (!r.id) throw new Error(L("当前账号没有可用的生图模型", "No image model is available for this account"));
    const isEdit = !!req.images?.length;
    const body: any = { model: r.id, prompt: req.prompt, n: req.n ?? 1 };
    if (req.size) body.size = req.size;
    if (req.quality) body.quality = req.quality;
    if (req.background) body.background = req.background;
    if (isEdit) body.images = req.images!.map((u) => ({ image_url: u }));
    const entry = this.log.begin("POST", isEdit ? "[app] images/edits" : "[app] images/generations");
    entry.model = r.id;
    entry.route = isEdit ? "images/edits" : "images/generations";
    try {
      const j = await this.client.json(isEdit ? ENDPOINT.imagesEdit : ENDPOINT.imagesGen, body, { initiator: "user" });
      const images = (j.data ?? []).map((d: any) => ({
        dataUrl: d.b64_json ? `data:image/${j.output_format ?? "png"};base64,${d.b64_json}` : d.url,
        revisedPrompt: d.revised_prompt,
      }));
      entry.status = 200;
      if (j.usage) { entry.inputTokens = j.usage.input_tokens; entry.outputTokens = j.usage.output_tokens; }
      let savedPaths: string[] | undefined;
      if (saveDir) {
        fs.mkdirSync(saveDir, { recursive: true });
        savedPaths = [];
        for (const [i, img] of images.entries()) {
          const m = /^data:image\/(\w+);base64,(.*)$/s.exec(img.dataUrl ?? "");
          if (!m) continue;
          const p = path.join(saveDir, `copilot-image-${new Date().toISOString().replace(/[:.]/g, "-")}-${i}.${m[1]}`);
          fs.writeFileSync(p, Buffer.from(m[2], "base64"));
          savedPaths.push(p);
        }
      }
      return { model: r.id, images, durationMs: Date.now() - started, savedPaths };
    } catch (e: any) {
      entry.status = e?.status ?? 500;
      entry.error = e?.message;
      throw e;
    } finally {
      this.log.finish(entry);
    }
  }

  /** 通过本地代理发一条简短消息，验证模型端到端可用 */
  async testModel(model: string): Promise<{ ok: boolean; text?: string; error?: string; ms: number }> {
    const t0 = Date.now();
    if (!this.server.running) return { ok: false, error: L("代理未运行", "Proxy is not running"), ms: 0 };
    try {
      const res = await fetch(this.baseUrl() + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.settings.apiKey || "test"}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: pong" }], max_tokens: 2000, stream: false }),
      });
      const j: any = await res.json();
      if (!res.ok) return { ok: false, error: j?.error?.message ?? `HTTP ${res.status}`, ms: Date.now() - t0 };
      return { ok: true, text: j.choices?.[0]?.message?.content ?? "", ms: Date.now() - t0 };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e), ms: Date.now() - t0 };
    }
  }

  async dispose() {
    this.cancelLogin();
    await this.server.stop();
  }
}
