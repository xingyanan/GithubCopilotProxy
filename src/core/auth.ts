import type { DeviceLoginInfo, GithubUser, CopilotQuota, AdvancedSettings } from "../shared/types";
import { GITHUB_BASE, GITHUB_API, GITHUB_CLIENT_ID, GITHUB_SCOPES, DEFAULT_COPILOT_API } from "./constants";
import { L } from "./i18n";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error(L("已取消", "Cancelled"))); }, { once: true });
  });

function githubHeaders(adv: AdvancedSettings, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "editor-version": adv.editorVersion,
    "editor-plugin-version": adv.editorPluginVersion,
    "user-agent": adv.userAgent,
    "x-github-api-version": "2025-04-01",
  };
  if (token) h.authorization = `token ${token}`;
  return h;
}

/**
 * GitHub OAuth Device Flow
 * 1. POST /login/device/code 获取 user_code
 * 2. 用户在浏览器 https://github.com/login/device 输入
 * 3. 轮询 /login/oauth/access_token 直到授权
 */
export async function startDeviceFlow(fetchFn: FetchLike, adv: AdvancedSettings): Promise<DeviceLoginInfo & { deviceCode: string }> {
  const res = await fetchFn(`${GITHUB_BASE}/login/device/code`, {
    method: "POST",
    headers: githubHeaders(adv),
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }),
  });
  if (!res.ok) throw new Error(L(`获取 device code 失败: HTTP ${res.status}`, `Failed to get device code: HTTP ${res.status}`) + ` ${await res.text()}`);
  const j: any = await res.json();
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri || "https://github.com/login/device",
    expiresAt: Date.now() + (j.expires_in ?? 900) * 1000,
    interval: j.interval ?? 5,
  };
}

export async function pollDeviceFlow(
  fetchFn: FetchLike,
  adv: AdvancedSettings,
  deviceCode: string,
  intervalSec: number,
  expiresAt: number,
  signal?: AbortSignal,
): Promise<string> {
  let interval = Math.max(1, intervalSec);
  while (Date.now() < expiresAt) {
    await sleep((interval + 1) * 1000, signal);
    let j: any;
    try {
      const res = await fetchFn(`${GITHUB_BASE}/login/oauth/access_token`, {
        method: "POST",
        headers: githubHeaders(adv),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      });
      j = await res.json();
    } catch (e) {
      if (signal?.aborted) throw new Error(L("已取消", "Cancelled"));
      continue; // 网络抖动，继续轮询
    }
    if (j.access_token) return j.access_token as string;
    switch (j.error) {
      case "authorization_pending": break;
      case "slow_down": interval = (j.interval ?? interval + 5); break;
      case "expired_token": throw new Error(L("验证码已过期，请重新登录", "The code has expired. Please sign in again."));
      case "access_denied": throw new Error(L("用户拒绝了授权", "Authorization was denied"));
      default: if (j.error) throw new Error(L("登录失败: ", "Sign-in failed: ") + (j.error_description || j.error));
    }
  }
  throw new Error(L("验证码已过期，请重新登录", "The code has expired. Please sign in again."));
}

export async function fetchGithubUser(fetchFn: FetchLike, adv: AdvancedSettings, token: string): Promise<GithubUser> {
  const res = await fetchFn(`${GITHUB_API}/user`, { headers: githubHeaders(adv, token) });
  if (!res.ok) throw new Error(L("获取 GitHub 用户失败", "Failed to load GitHub user") + `: HTTP ${res.status}`);
  const j: any = await res.json();
  return { login: j.login, name: j.name, avatarUrl: j.avatar_url };
}

/** /copilot_internal/user：订阅计划与配额（尽力而为，字段可能随时间变化） */
export async function fetchCopilotQuota(fetchFn: FetchLike, adv: AdvancedSettings, token: string): Promise<CopilotQuota | undefined> {
  try {
    const res = await fetchFn(`${GITHUB_API}/copilot_internal/user`, { headers: githubHeaders(adv, token) });
    if (!res.ok) return undefined;
    const j: any = await res.json();
    const snap = j.quota_snapshots ?? {};
    const pick = (s: any) =>
      s ? { entitlement: Number(s.entitlement ?? 0), remaining: Number(s.remaining ?? 0), unlimited: !!s.unlimited, percentRemaining: s.percent_remaining } : undefined;
    return {
      plan: j.copilot_plan ?? j.access_type_sku,
      resetDate: j.quota_reset_date,
      premium: pick(snap.premium_interactions),
      chat: pick(snap.chat),
    };
  } catch {
    return undefined;
  }
}

interface CopilotToken {
  token: string;
  expiresAt: number; // ms
  refreshAt: number; // ms
  apiBase: string;
}

/** 管理短期 Copilot token（约 30 分钟有效），自动提前刷新、并发去重 */
export class CopilotTokenManager {
  private current?: CopilotToken;
  private inflight?: Promise<CopilotToken>;

  constructor(
    private fetchFn: () => FetchLike,
    private adv: () => AdvancedSettings,
    private githubToken: () => string | undefined,
  ) {}

  reset() { this.current = undefined; this.inflight = undefined; }

  get info() { return this.current ? { apiBase: this.current.apiBase, expiresAt: this.current.expiresAt } : undefined; }

  async get(force = false): Promise<CopilotToken> {
    const now = Date.now();
    if (!force && this.current && now < this.current.refreshAt) return this.current;
    if (!this.inflight) {
      this.inflight = this.exchange().finally(() => { this.inflight = undefined; });
    }
    return this.inflight;
  }

  private async exchange(): Promise<CopilotToken> {
    const gh = this.githubToken();
    if (!gh) throw new NotLoggedInError();
    const res = await this.fetchFn()(`${GITHUB_API}/copilot_internal/v2/token`, { headers: githubHeaders(this.adv(), gh) });
    if (res.status === 401) throw new NotLoggedInError(L("GitHub 登录已失效，请重新登录", "GitHub sign-in has expired. Please sign in again."));
    if (!res.ok) {
      const t = await res.text();
      if (res.status === 403 || res.status === 404) throw new Error(L("该 GitHub 账号没有可用的 Copilot 订阅", "This GitHub account has no active Copilot subscription") + ` (HTTP ${res.status}): ${t}`);
      throw new Error(L("获取 Copilot token 失败", "Failed to get Copilot token") + `: HTTP ${res.status} ${t}`);
    }
    const j: any = await res.json();
    const expiresAt = (j.expires_at ? j.expires_at * 1000 : Date.now() + 25 * 60_000);
    const refreshIn = (j.refresh_in ?? 1500) * 1000;
    this.current = {
      token: j.token,
      expiresAt,
      refreshAt: Math.min(Date.now() + refreshIn - 60_000, expiresAt - 120_000),
      apiBase: (j.endpoints?.api || DEFAULT_COPILOT_API).replace(/\/+$/, ""),
    };
    return this.current;
  }
}

export class NotLoggedInError extends Error {
  constructor(msg?: string) { super(msg ?? L("尚未登录 GitHub，请先在应用中完成登录", "Not signed in to GitHub. Sign in from the app first.")); }
}
