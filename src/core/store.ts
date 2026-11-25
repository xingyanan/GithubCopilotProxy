import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings, GithubUser } from "../shared/types";
import { DEFAULT_SETTINGS, DEFAULT_ADVANCED } from "./constants";

/** 可选的加解密钩子（Electron 下使用 safeStorage，CLI 下为明文 + 文件权限 0600） */
export interface SecretCodec {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export const plainCodec: SecretCodec = {
  encrypt: (s) => "plain:" + Buffer.from(s, "utf8").toString("base64"),
  decrypt: (s) => (s.startsWith("plain:") ? Buffer.from(s.slice(6), "base64").toString("utf8") : s),
};

interface PersistedData {
  settings: Settings;
  auth?: { githubToken: string; user?: GithubUser; savedAt: number };
  /** 应用集成前原始值，用于精确还原 */
  integrationBackup?: {
    claude?: Record<string, string | null>;
    codex?: Record<string, string | null>;
  };
}

function deepMerge<T>(base: T, patch: any): T {
  if (patch === undefined || patch === null) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch as T;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)[k];
    const pv = patch[k];
    if (bv && typeof bv === "object" && !Array.isArray(bv) && pv && typeof pv === "object" && !Array.isArray(pv) && k !== "modelAliases") {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

export class Store {
  private data: PersistedData;
  private file: string;

  constructor(public readonly dir: string, private codec: SecretCodec = plainCodec) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "config.json");
    this.data = { settings: structuredClone(DEFAULT_SETTINGS) };
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.data = {
          ...parsed,
          settings: deepMerge(structuredClone(DEFAULT_SETTINGS), parsed.settings ?? {}),
        };
        this.data.settings.advanced = { ...DEFAULT_ADVANCED, ...this.data.settings.advanced };
      }
    } catch (e) {
      // 配置损坏时备份后重置，避免应用无法启动
      try { fs.copyFileSync(this.file, this.file + ".corrupt-" + Date.now()); } catch {}
    }
  }

  setCodec(codec: SecretCodec) { this.codec = codec; }

  private save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get settings(): Settings { return this.data.settings; }

  updateSettings(patch: Partial<Settings> | any): Settings {
    this.data.settings = deepMerge(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  getGithubToken(): string | undefined {
    const t = this.data.auth?.githubToken;
    if (!t) return undefined;
    try { return this.codec.decrypt(t); } catch { return undefined; }
  }

  getUser(): GithubUser | undefined { return this.data.auth?.user; }

  setAuth(token: string, user?: GithubUser) {
    this.data.auth = { githubToken: this.codec.encrypt(token), user, savedAt: Date.now() };
    this.save();
  }

  setUser(user: GithubUser) {
    if (this.data.auth) { this.data.auth.user = user; this.save(); }
  }

  clearAuth() { delete this.data.auth; this.save(); }

  getIntegrationBackup(kind: "claude" | "codex") { return this.data.integrationBackup?.[kind]; }

  setIntegrationBackup(kind: "claude" | "codex", value: Record<string, string | null> | undefined) {
    this.data.integrationBackup = this.data.integrationBackup ?? {};
    if (value === undefined) delete this.data.integrationBackup[kind];
    else this.data.integrationBackup[kind] = value;
    this.save();
  }
}
