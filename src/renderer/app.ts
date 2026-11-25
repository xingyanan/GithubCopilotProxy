import type { AppState, CopilotModel, Settings } from "../shared/types";

interface Api {
  invoke<T = any>(method: string, ...args: unknown[]): Promise<T>;
  onState(cb: (s: AppState) => void): () => void;
  platform: string;
}
declare global { interface Window { api: Api } }

const api = window.api;
const view = document.getElementById("view")!;
let state: AppState;
let tab: "home" | "models" | "settings" = "home";
let modelQuery = "";
let lastHtml = "";

// ------------------------------------------------------------------ 工具函数

/** 双语文案：L("中文", "English") */
const L = (zh: string, en: string) => (state?.lang === "en" ? en : zh);

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

let toastTimer: number | undefined;
function toast(msg: string, err = false) {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = "toast"), err ? 5000 : 2000);
}

async function call<T = any>(method: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    return await api.invoke<T>(method, ...args);
  } catch (e: any) {
    toast(e?.message ?? String(e), true);
    return undefined;
  }
}

const chatModels = () => state.models.filter((m) => m.kind === "chat" && m.policyState !== "disabled");
const imageModels = () => state.models.filter((m) => m.kind === "image" && m.policyState !== "disabled");

function options(list: CopilotModel[], selected: string, empty?: string) {
  const out = list.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(m.id)}</option>`);
  if (selected && !list.some((m) => m.id === selected)) out.unshift(`<option value="${esc(selected)}" selected>${esc(selected)}</option>`);
  if (empty !== undefined) out.unshift(`<option value=""${selected ? "" : " selected"}>${esc(empty)}</option>`);
  if (!out.length) out.push(`<option value="">${L("登录后可选", "Sign in first")}</option>`);
  return out.join("");
}

const sw = (attrs: string, checked: boolean) => `<label class="switch"><input type="checkbox" ${attrs}${checked ? " checked" : ""}><i></i></label>`;

// ------------------------------------------------------------------ 图标

/** Claude Code：橙色放射状星芒 */
const ICON_CLAUDE = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#F5E6DE"/>
<g stroke="#D97757" stroke-width="2.6" stroke-linecap="round">
${[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a, i) => {
  const r = i % 2 ? 7.5 : 10;
  const x = 16 + r * Math.cos((a * Math.PI) / 180), y = 16 + r * Math.sin((a * Math.PI) / 180);
  return `<line x1="16" y1="16" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}"/>`;
}).join("")}
</g></svg>`;

/** Codex：深色终端窗口 + 提示符 */
const ICON_CODEX = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#111827"/>
<path d="M9 11.5l5 4.5-5 4.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M16.5 21h7" stroke="#10A37F" stroke-width="2.4" stroke-linecap="round"/></svg>`;

// ------------------------------------------------------------------ 首页

let countdown: number | undefined;

function avatar(): string {
  const u = state.user;
  const src = u?.avatarDataUrl || u?.avatarUrl;
  if (src) return `<img class="avatar" src="${esc(src)}" alt="">`;
  return `<div class="avatar">${esc((u?.login ?? "?").slice(0, 1).toUpperCase())}</div>`;
}

/** 账号行：未登录 / 等待授权 / 已登录 三种状态共用同一位置 */
function accountRow(): string {
  const s = state;
  clearInterval(countdown);
  if (s.login.status === "pending") {
    const info = s.login.info;
    countdown = window.setInterval(() => {
      const el = document.getElementById("left");
      if (!el) return;
      const sec = Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000));
      el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    }, 1000);
    return `
      <div class="item">
        <div class="grow">
          <div class="code">${esc(info.userCode)}</div>
          <div class="sub">${L("在 GitHub 页面输入此验证码，", "Enter this code on GitHub, expires in ")}<span id="left">--:--</span>${L(" 后过期", "")}<button class="btn link" data-act="cancelLogin">${L("取消", "Cancel")}</button></div>
        </div>
        <button class="btn primary" data-act="openDevice" data-code="${esc(info.userCode)}" data-url="${esc(info.verificationUri)}">${L("复制并打开 GitHub", "Copy & open GitHub")}</button>
      </div>`;
  }
  if (!s.loggedIn) {
    return `
      <div class="item">
        <div class="avatar"></div>
        <div class="grow">
          <div class="name">${L("未登录", "Not signed in")}</div>
          <div class="sub ${s.login.status === "error" ? "err-text" : ""}">${s.login.status === "error" ? esc(s.login.message) : L("需要开通了 Copilot 的 GitHub 账号", "Requires a GitHub account with Copilot")}</div>
        </div>
        <button class="btn primary" data-act="startLogin">${L("登录 GitHub", "Sign in with GitHub")}</button>
      </div>`;
  }
  const sub = s.modelsError ? `<span class="err-text">${esc(s.modelsError)}</span>` : esc(planName());
  return `
    <div class="item">
      ${avatar()}
      <div class="grow">
        <div class="name">${esc(s.user?.name || s.user?.login || "")}${s.user?.name ? ` <span class="muted">${esc(s.user.login)}</span>` : ""}</div>
        <div class="sub">${sub}</div>
      </div>
      <button class="btn link danger" data-act="logout">${L("退出", "Sign out")}</button>
    </div>`;
}

function planName(): string {
  const p = (state.quota?.plan ?? "").toLowerCase();
  const map: Record<string, string> = {
    free: "Copilot Free", individual: "Copilot Pro", individual_pro: "Copilot Pro+", pro: "Copilot Pro", pro_plus: "Copilot Pro+",
    business: "Copilot Business", enterprise: "Copilot Enterprise",
  };
  return map[p] ?? (p ? `Copilot ${state.quota!.plan}` : "GitHub Copilot");
}

/** 高级请求额度：进度条 + 剩余/总量 + 重置日期 */
function quotaRow(): string {
  const p = state.quota?.premium;
  if (!state.loggedIn || !p) return "";
  const reset = state.quota?.resetDate ? new Date(state.quota.resetDate) : undefined;
  const resetText = reset && !isNaN(+reset)
    ? reset.toLocaleDateString(state.lang === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric" })
    : "";
  const label = L("高级请求剩余", "Premium requests left");
  const resetHtml = resetText ? `<span class="q-reset">${L(`${resetText} 重置`, `resets ${resetText}`)}</span>` : "";
  if (p.unlimited) {
    return `<div class="item quota"><span class="q-spacer"></span><div class="grow"><div class="q-head"><span>${label}</span></div></div><span class="pill on">${L("不限量", "Unlimited")}</span></div>`;
  }
  const pct = p.entitlement > 0 ? Math.max(0, Math.min(100, (p.remaining / p.entitlement) * 100)) : 0;
  const level = pct < 15 ? "low" : pct < 40 ? "mid" : "ok";
  return `
    <div class="item quota">
      <span class="q-spacer"></span>
      <div class="grow">
        <div class="q-head"><span>${label}</span>${resetHtml}</div>
        <div class="bar ${level}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${p.entitlement}" aria-valuenow="${Math.round(p.remaining)}"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>
      <div class="q-num"><b>${Math.round(p.remaining)}</b><span>/ ${p.entitlement}</span></div>
    </div>`;
}

/** 服务行：地址 + 状态 + 复制 + 开关 */
function serviceRow(): string {
  const p = state.proxy;
  const status = p.error
    ? `<span class="err-text">${esc(p.error)}</span>`
    : `<span class="state ${p.running ? "on" : ""}"><span class="dot ${p.running ? "on" : ""}"></span>${p.running ? L("API 服务运行中", "API service running") : L("API 服务已停止", "API service stopped")}</span>${p.running && state.settings.apiKey ? L("，需要访问密钥", " · API key required") : ""}`;
  return `
    <div class="item">
      <span class="svc-icon ${p.error ? "err" : p.running ? "on" : ""}" aria-hidden="true"></span>
      <div class="grow">
        <div class="addr">${esc(p.url)}</div>
        <div class="sub">${status}</div>
      </div>
      <button class="btn link" data-copy="${esc(p.url)}/v1">${L("复制", "Copy")}</button>
      ${sw(`data-act="toggleProxy" aria-label="${L("启用 API 服务", "Enable API service")}"`, p.running)}
    </div>`;
}

function toolRow(kind: "claude" | "codex"): string {
  const s = state.settings;
  const st = state.integrations[kind];
  const name = kind === "claude" ? "Claude Code" : "Codex";
  const model = kind === "claude" ? s.claude.model : s.codex.model;
  const disabled = state.loggedIn ? "" : " disabled";
  return `
    <div class="item">
      <span class="tool-icon">${kind === "claude" ? ICON_CLAUDE : ICON_CODEX}</span>
      <div class="tool">
        <div class="name">${name}</div>
        <div class="sub"><span class="state ${st.applied ? "on" : ""}"><span class="dot ${st.applied ? "on" : ""}"></span>${st.applied ? L("已配置", "Configured") : L("未配置", "Not set")}</span>${st.applied ? `<button class="btn link" data-act="restore-${kind}">${L("还原", "Restore")}</button>` : ""}</div>
      </div>
      <select class="grow" data-model="${kind}" aria-label="${name} model"${disabled}>${options(chatModels(), model)}</select>
      <button class="btn ${st.applied ? "" : "primary"}" data-act="apply-${kind}"${disabled}>${st.applied ? L("更新", "Update") : L("配置", "Apply")}</button>
    </div>`;
}

function renderHome(): string {
  return `
    <div class="list">${accountRow()}${quotaRow()}${serviceRow()}</div>
    <div class="group-head" style="margin-top:16px"><h2>${L("一键配置", "One-click setup")}</h2><span class="aside">${L("原配置自动备份，重启工具后生效", "Backs up your config; restart the tool to apply")}</span></div>
    <div class="list">${toolRow("claude")}${toolRow("codex")}</div>`;
}

// ------------------------------------------------------------------ 模型

function modelItems(): string {
  const q = modelQuery.trim().toLowerCase();
  const list = state.models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  const tag = (m: CopilotModel) =>
    m.kind === "image" ? `<span class="tag image">${L("生图", "Image")}</span>`
      : m.kind === "chat" ? `<span class="tag">${L("对话", "Chat")}</span>`
      : `<span class="tag other">${m.kind === "embeddings" ? L("向量", "Embedding") : L("其他", "Other")}</span>`;
  return list.length ? list.map((m) => `
    <div class="item">
      <div class="grow">
        <div class="addr" style="font-size:13px">${esc(m.id)}</div>
        <div class="sub">${esc(m.vendor)}${m.multiplier !== undefined ? ` · ×${m.multiplier}` : ""}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ${L("上下文", "context")}` : ""}</div>
      </div>
      ${tag(m)}
      <button class="btn link" data-copy="${esc(m.id)}">${L("复制", "Copy")}</button>
    </div>`).join("") : `<div class="empty">${state.models.length ? L("没有匹配的模型", "No matching models") : L("暂无模型，点击“刷新”重试", "No models yet. Click Refresh.")}</div>`;
}

function renderModels(): string {
  if (!state.loggedIn) return `<div class="list empty">${L("登录 GitHub Copilot 后显示可用模型", "Sign in to GitHub Copilot to see available models")}</div>`;
  return `
    <section class="group">
      <div class="group-head"><h2>${L("可用模型", "Available models")} (${state.models.length})</h2><button class="btn link" data-act="refreshModels">${L("刷新", "Refresh")}</button></div>
      <div class="filter"><input type="text" id="mq" placeholder="${L("搜索模型", "Search models")}" value="${esc(modelQuery)}"></div>
      <div class="list" id="mlist">${modelItems()}</div>
      <p class="hint">${L("与 GET /v1/models 返回一致。×N 表示每次请求消耗的高级请求数。", "Same as GET /v1/models. ×N is the premium-request cost per call.")}</p>
    </section>`;
}

// ------------------------------------------------------------------ 设置

function renderSettings(): string {
  const s = state.settings;
  const lan = s.host === "0.0.0.0";
  const row = (name: string, sub: string, control: string) =>
    `<div class="item"><div class="grow"><div class="name">${name}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${control}</div>`;
  const sel = (key: string, cur: string, opts: [string, string][]) =>
    `<select data-set="${key}">${opts.map(([v, t]) => `<option value="${v}"${cur === v ? " selected" : ""}>${t}</option>`).join("")}</select>`;
  return `
    <section class="group">
      <div class="group-head"><h2>${L("服务", "Service")}</h2></div>
      <div class="list">
        ${row(L("端口", "Port"), "", `<input type="number" min="1" max="65535" value="${s.port}" data-set="port" style="width:96px">`)}
        ${row(L("访问密钥", "API key"), "", `<input type="text" class="addr" style="width:180px;font-size:12px" value="${esc(s.apiKey)}" placeholder="${L("不校验", "Not required")}" data-set="apiKey"><button class="btn link" data-act="genKey">${L("生成", "Generate")}</button>`)}
        ${row(L("允许局域网访问", "Allow LAN access"), L("需先设置访问密钥", "Requires an API key"), sw(`data-set="lan"`, lan))}
      </div>
    </section>
    <section class="group">
      <div class="group-head"><h2>${L("模型映射", "Model mapping")}</h2></div>
      <div class="list">
        ${row("Claude Code · Opus", "", `<select data-set="claude.opusModel">${options(chatModels(), s.claude.opusModel, L("同主模型", "Same as main"))}</select>`)}
        ${row(L("Claude Code · 后台模型", "Claude Code · Background"), L("建议选 ×0 模型", "A ×0 model is recommended"), `<select data-set="claude.smallModel">${options(chatModels(), s.claude.smallModel, L("同主模型", "Same as main"))}</select>`)}
        ${row(L("Codex · 推理强度", "Codex · Reasoning effort"), "", sel("codex.reasoningEffort", s.codex.reasoningEffort, [["", L("默认", "Default")], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"]]))}
        ${row(L("默认生图模型", "Default image model"), L("请求的生图模型不存在时使用", "Used when the requested image model is unavailable"), `<select data-set="imageModel">${options(imageModels(), s.imageModel, L("自动", "Auto"))}</select>`)}
        ${row(L("默认对话模型", "Default chat model"), "", `<select data-set="defaultModel">${options(chatModels(), s.defaultModel, L("自动", "Auto"))}</select>`)}
      </div>
    </section>
    <section class="group">
      <div class="group-head"><h2>${L("通用", "General")}</h2></div>
      <div class="list">
        ${row(L("语言", "Language"), "", sel("language", s.language, [["auto", L("跟随系统", "System")], ["zh", "中文"], ["en", "English"]]))}
        ${row(L("打开应用时自动启动服务", "Start service on launch"), "", sw(`data-set="autoStartProxy"`, s.autoStartProxy))}
        ${row(L("开机自动运行", "Launch at login"), "", sw(`data-set="launchAtLogin"`, s.launchAtLogin))}
        ${row(L("关闭窗口时收起到托盘", "Minimize to tray on close"), "", sw(`data-set="closeToTray"`, s.closeToTray))}
        ${row(L("使用系统代理访问 GitHub", "Use system proxy for GitHub"), "", sw(`data-set="useSystemProxy"`, s.useSystemProxy))}
      </div>
      <p class="hint">Copilot Proxy ${esc(state.version)}<button class="btn link" data-act="quit">${L("退出应用", "Quit")}</button></p>
    </section>`;
}

// ------------------------------------------------------------------ 渲染与事件

function renderChrome() {
  document.documentElement.lang = state.lang === "en" ? "en" : "zh-CN";
  const labels: Record<string, string> = { home: L("首页", "Home"), models: L("模型", "Models"), settings: L("设置", "Settings") };
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) => {
    b.textContent = labels[b.dataset.tab!];
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  });
  const lb = document.getElementById("langBtn")!;
  lb.textContent = state.lang === "en" ? "中" : "EN";
  lb.title = state.lang === "en" ? "切换到中文" : "Switch to English";
}

function render(force = false) {
  renderChrome();
  // 设置页只在切换进入时渲染，避免输入时被状态刷新打断
  if (tab === "settings" && !force) return;
  const active = document.activeElement as HTMLElement | null;
  if (!force && active && view.contains(active) && (active.tagName === "SELECT" || active.tagName === "INPUT")) return;
  const html = tab === "home" ? renderHome() : tab === "models" ? renderModels() : renderSettings();
  if (html === lastHtml && !force) return;
  lastHtml = html;
  view.innerHTML = html;
}

async function refreshState() {
  state = await api.invoke<AppState>("getState");
}

document.getElementById("langBtn")!.addEventListener("click", async () => {
  await call("updateSettings", { language: state.lang === "en" ? "zh" : "en" });
  await refreshState();
  render(true);
});

view.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id !== "mq") return;
  modelQuery = el.value;
  document.getElementById("mlist")!.innerHTML = modelItems();
});

document.getElementById("tabs")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab as typeof tab;
  render(true);
  view.scrollTop = 0;
});

view.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-copy],[data-act]");
  if (!el || el instanceof HTMLInputElement) return;
  if (el.dataset.copy) {
    await call("copy", el.dataset.copy);
    toast(L("已复制 ", "Copied ") + el.dataset.copy);
    return;
  }
  const act = el.dataset.act!;
  el.setAttribute("disabled", "");
  try {
    switch (act) {
      case "startLogin": await call("startLogin"); break;
      case "cancelLogin": await call("cancelLogin"); break;
      case "openDevice":
        await call("copy", el.dataset.code);
        await call("openExternal", el.dataset.url);
        toast(L("验证码已复制，在浏览器中粘贴即可", "Code copied. Paste it in the browser."));
        break;
      case "logout":
        if (confirm(L("确定退出登录？", "Sign out?"))) await call("logout");
        break;
      case "refreshModels":
        if (await call("refreshModels")) toast(L("模型列表已刷新", "Model list refreshed"));
        break;
      case "apply-claude":
      case "apply-codex": {
        const name = act === "apply-claude" ? "Claude Code" : "Codex";
        const file = await call<string>(act === "apply-claude" ? "applyClaude" : "applyCodex");
        if (file) toast(L(`已写入 ${file}，重启 ${name} 后生效`, `Wrote ${file}. Restart ${name} to apply.`));
        break;
      }
      case "restore-claude":
      case "restore-codex": {
        const file = await call<string>(act === "restore-claude" ? "restoreClaude" : "restoreCodex");
        if (file) toast(L("已还原 ", "Restored ") + file);
        break;
      }
      case "genKey": {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        const key = "sk-cp-" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
        const input = view.querySelector<HTMLInputElement>('[data-set="apiKey"]')!;
        input.value = key;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
      case "quit": await call("quit"); break;
    }
  } finally {
    el.removeAttribute("disabled");
  }
});

view.addEventListener("change", async (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  // 首页：工具模型选择
  if (el.dataset.model) {
    const kind = el.dataset.model as "claude" | "codex";
    await call("updateSettings", kind === "claude" ? { claude: { model: el.value } } : { codex: { model: el.value } });
    // 已配置时直接同步到工具配置文件
    if (state.integrations[kind].applied) {
      await call(kind === "claude" ? "applyClaude" : "applyCodex");
      toast(L("已更新为 ", "Updated to ") + el.value);
    }
    (el as HTMLElement).blur();
    return;
  }
  if (el.dataset.act === "toggleProxy") {
    const input = el as HTMLInputElement;
    const on = input.checked;
    input.disabled = true;
    try {
      await api.invoke(on ? "startProxy" : "stopProxy");
      toast(on ? L("API 服务已启动", "API service started") : L("API 服务已停止", "API service stopped"));
    } catch (err: any) {
      toast(err?.message ?? String(err), true);
    }
    // 以主进程真实状态为准刷新（启动失败时开关回到关闭）
    await refreshState();
    render(true);
    return;
  }
  const key = el.dataset.set;
  if (!key) return;
  let patch: Partial<Settings> | any;
  const checked = (el as HTMLInputElement).checked;
  switch (key) {
    case "port": {
      const port = Number(el.value);
      if (!(port > 0 && port < 65536)) { toast(L("端口需要在 1–65535 之间", "Port must be between 1 and 65535"), true); return; }
      patch = { port };
      break;
    }
    case "apiKey": patch = { apiKey: el.value.trim() }; break;
    case "lan":
      if (checked && !state.settings.apiKey) {
        (el as HTMLInputElement).checked = false;
        toast(L("请先设置访问密钥", "Set an API key first"), true);
        return;
      }
      patch = { host: checked ? "0.0.0.0" : "127.0.0.1" };
      break;
    case "autoStartProxy": case "launchAtLogin": case "closeToTray": case "useSystemProxy":
      patch = { [key]: checked };
      break;
    default: {
      const [a, b] = key.split(".");
      patch = b ? { [a]: { [b]: el.value } } : { [a]: el.value };
    }
  }
  if (key === "apiKey" && !patch.apiKey && state.settings.host === "0.0.0.0") patch.host = "127.0.0.1";
  try {
    await api.invoke("updateSettings", patch);
  } catch (err: any) {
    // 端口被占用等：设置未保存，输入框恢复原值，原服务不受影响
    toast(err?.message ?? String(err), true);
    if (key === "port") (el as HTMLInputElement).value = String(state.settings.port);
    if (key === "lan") (el as HTMLInputElement).checked = state.settings.host === "0.0.0.0";
    return;
  }
  await refreshState();
  if (key === "language") { render(true); return; }
  if (key === "port" || key === "lan") {
    const p = state.proxy;
    if (p.error) toast(p.error, true);
    else toast(p.running ? L(`已保存，服务运行在 ${p.url}`, `Saved. Service running at ${p.url}`) : L(`已保存，端口 ${state.settings.port}`, `Saved. Port ${state.settings.port}`));
  } else toast(L("已保存", "Saved"));
});

async function boot() {
  await refreshState();
  api.onState((s) => { state = s; render(); });
  render(true);
}
boot();
