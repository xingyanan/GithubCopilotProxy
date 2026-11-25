/**
 * 一键把本地代理写入 Claude Code (~/.claude/settings.json) 与 Codex (~/.codex/config.toml)。
 * - 首次写入前备份原文件（*.copilot-proxy.bak）
 * - 记录被覆盖键的原值，"还原" 时精确恢复，不影响用户之后对其他配置的修改
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IntegrationStatus } from "../shared/types";
import { L } from "./i18n";

const BACKUP_SUFFIX = ".copilot-proxy.bak";

export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

export function codexConfigPath(): string {
  const dir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(dir, "config.toml");
}

function backupOnce(file: string) {
  const bak = file + BACKUP_SUFFIX;
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function writeAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

// ============================ Claude Code ============================

export interface ClaudeApplyOptions {
  baseUrl: string; // 例如 http://127.0.0.1:4141（不带 /v1）
  authToken: string;
  model: string;
  opusModel?: string;
  smallModel?: string;
  disableNonEssentialTraffic?: boolean;
}

const CLAUDE_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

function readClaude(file: string): any {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw new Error(L(`${file} 不是合法的 JSON，已停止写入以免破坏配置：`, `${file} is not valid JSON; nothing was written to avoid breaking it: `) + e.message);
  }
}

export function applyClaude(opts: ClaudeApplyOptions, prevBackup?: Record<string, string | null>): { file: string; backup: Record<string, string | null> } {
  if (!opts.model) throw new Error(L("请先选择 Claude Code 使用的模型", "Choose a model for Claude Code first"));
  const file = claudeSettingsPath();
  const data = readClaude(file);
  backupOnce(file);
  const env: Record<string, string> = { ...(data.env ?? {}) };
  // 只在第一次应用时记录原值（重复应用不会覆盖原始备份）
  const backup: Record<string, string | null> = prevBackup ?? Object.fromEntries(CLAUDE_KEYS.map((k) => [k, env[k] ?? null]));

  const small = opts.smallModel || opts.model;
  const next: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: opts.baseUrl,
    ANTHROPIC_AUTH_TOKEN: opts.authToken,
    ANTHROPIC_API_KEY: undefined, // 与 AUTH_TOKEN 同时存在会触发认证冲突提示
    ANTHROPIC_MODEL: opts.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: opts.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: opts.opusModel || opts.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: opts.disableNonEssentialTraffic === false ? undefined : "1",
  };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  data.env = env;
  writeAtomic(file, JSON.stringify(data, null, 2) + "\n");
  return { file, backup };
}

export function restoreClaude(backup: Record<string, string | null> | undefined, ourBaseUrl: string): string {
  const file = claudeSettingsPath();
  if (!fs.existsSync(file)) return file;
  const data = readClaude(file);
  const env: Record<string, string> = { ...(data.env ?? {}) };
  if (backup) {
    for (const k of CLAUDE_KEYS) {
      const v = backup[k];
      if (v === null || v === undefined) delete env[k];
      else env[k] = v;
    }
  } else if (env.ANTHROPIC_BASE_URL === ourBaseUrl) {
    for (const k of CLAUDE_KEYS) delete env[k];
  }
  if (Object.keys(env).length) data.env = env;
  else delete data.env;
  writeAtomic(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

export function claudeStatus(ourBaseUrl: string): IntegrationStatus {
  const file = claudeSettingsPath();
  const exists = fs.existsSync(file);
  let env: any = {};
  try { env = readClaude(file).env ?? {}; } catch {}
  const base = env.ANTHROPIC_BASE_URL as string | undefined;
  return {
    configPath: file,
    exists,
    applied: !!base && sameBase(base, ourBaseUrl),
    baseUrl: base,
    model: env.ANTHROPIC_MODEL,
    hasBackup: fs.existsSync(file + BACKUP_SUFFIX),
  };
}

const sameBase = (a: string, b: string) => a.replace(/\/+$/, "").replace("localhost", "127.0.0.1") === b.replace(/\/+$/, "").replace("localhost", "127.0.0.1");

// ============================ Codex ============================

export interface CodexApplyOptions {
  providerId: string;
  baseUrl: string; // 例如 http://127.0.0.1:4141/v1
  apiKey?: string;
  model: string;
  reasoningEffort?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

const CODEX_TOP_KEYS = ["model", "model_provider", "model_reasoning_effort", "model_context_window", "model_max_output_tokens"] as const;

const isHeader = (line: string) => /^\s*\[/.test(line);

function topRegionEnd(lines: string[]): number {
  const i = lines.findIndex(isHeader);
  return i < 0 ? lines.length : i;
}

/** 读取顶层键的原始 TOML 值文本 */
export function tomlGetTop(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  const end = topRegionEnd(lines);
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*(.*?)\\s*$`);
  for (let i = 0; i < end; i++) {
    const m = re.exec(lines[i]);
    if (m) return stripComment(m[1]);
  }
  return null;
}

/** 设置/删除顶层键（rawValue 为已编码的 TOML 值，null 表示删除） */
export function tomlSetTop(text: string, key: string, rawValue: string | null): string {
  const lines = text.split(/\r?\n/);
  const end = topRegionEnd(lines);
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  for (let i = 0; i < end; i++) {
    if (re.test(lines[i])) {
      if (rawValue === null) lines.splice(i, 1);
      else lines[i] = `${key} = ${rawValue}`;
      return lines.join("\n");
    }
  }
  if (rawValue === null) return text;
  // 插入到顶层区域末尾（第一个表头之前），跳过尾部空行
  let at = end;
  while (at > 0 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, `${key} = ${rawValue}`);
  return lines.join("\n");
}

function tableRe(id: string) {
  return new RegExp(`^\\s*\\[\\s*model_providers\\.("?)${escapeRe(id)}\\1\\s*(\\]|\\.)`);
}

export function tomlRemoveProvider(text: string, id: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  const re = tableRe(id);
  for (const line of lines) {
    if (isHeader(line)) skipping = re.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function tomlHasProvider(text: string, id: string): boolean {
  const re = tableRe(id);
  return text.split(/\r?\n/).some((l) => re.test(l));
}

const tomlStr = (s: string) => JSON.stringify(s);

function stripComment(v: string): string {
  // 仅处理简单情况：引号外的 # 注释
  let inStr: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (inStr) { if (c === "\\" && inStr === '"') i++; else if (c === inStr) inStr = null; }
    else if (c === '"' || c === "'") inStr = c;
    else if (c === "#") return v.slice(0, i).trim();
  }
  return v.trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") : "";
}

export function buildCodexConfig(text: string, opts: CodexApplyOptions): string {
  let t = text;
  t = tomlSetTop(t, "model", tomlStr(opts.model));
  t = tomlSetTop(t, "model_provider", tomlStr(opts.providerId));
  t = tomlSetTop(t, "model_reasoning_effort", opts.reasoningEffort ? tomlStr(opts.reasoningEffort) : null);
  t = tomlSetTop(t, "model_context_window", opts.contextWindow ? String(opts.contextWindow) : null);
  t = tomlSetTop(t, "model_max_output_tokens", opts.maxOutputTokens ? String(opts.maxOutputTokens) : null);
  t = tomlRemoveProvider(t, opts.providerId).replace(/\s*$/, "");
  const table = [
    `[model_providers.${opts.providerId}]`,
    `name = "GitHub Copilot (local proxy)"`,
    `base_url = ${tomlStr(opts.baseUrl)}`,
    `wire_api = "responses"`,
    `request_max_retries = 4`,
    `stream_max_retries = 5`,
    `stream_idle_timeout_ms = 300000`,
  ];
  if (opts.apiKey) table.push(`http_headers = { "Authorization" = ${tomlStr("Bearer " + opts.apiKey)} }`);
  return (t ? t + "\n\n" : "") + "# Generated by Copilot Proxy (can be restored from the app)\n" + table.join("\n") + "\n";
}

export function applyCodex(opts: CodexApplyOptions, prevBackup?: Record<string, string | null>): { file: string; backup: Record<string, string | null> } {
  if (!opts.model) throw new Error(L("请先选择 Codex 使用的模型", "Choose a model for Codex first"));
  const file = codexConfigPath();
  const text = readText(file);
  backupOnce(file);
  const backup = prevBackup ?? Object.fromEntries(CODEX_TOP_KEYS.map((k) => [k, tomlGetTop(text, k)]));
  writeAtomic(file, buildCodexConfig(text, opts));
  return { file, backup };
}

export function restoreCodex(backup: Record<string, string | null> | undefined, providerId: string): string {
  const file = codexConfigPath();
  if (!fs.existsSync(file)) return file;
  let t = readText(file);
  t = t.replace(/^# (由 Copilot Proxy 自动生成|Generated by Copilot Proxy).*\r?\n/m, "");
  t = tomlRemoveProvider(t, providerId);
  if (backup) {
    for (const k of CODEX_TOP_KEYS) t = tomlSetTop(t, k, backup[k] ?? null);
  } else if (tomlGetTop(t, "model_provider") === tomlStr(providerId)) {
    t = tomlSetTop(t, "model_provider", null);
  }
  writeAtomic(file, t.replace(/\s*$/, "") + "\n");
  return file;
}

export function codexStatus(providerId: string, ourBaseUrl: string): IntegrationStatus {
  const file = codexConfigPath();
  const exists = fs.existsSync(file);
  const text = readText(file);
  const provider = tomlGetTop(text, "model_provider");
  const model = tomlGetTop(text, "model");
  let baseUrl: string | undefined;
  if (tomlHasProvider(text, providerId)) {
    const lines = text.split(/\r?\n/);
    const re = tableRe(providerId);
    let inTable = false;
    for (const l of lines) {
      if (isHeader(l)) inTable = re.test(l);
      else if (inTable) {
        const m = /^\s*base_url\s*=\s*"([^"]*)"/.exec(l);
        if (m) baseUrl = m[1];
      }
    }
  }
  const unq = (s: string | null) => (s ? s.replace(/^["']|["']$/g, "") : undefined);
  return {
    configPath: file,
    exists,
    applied: unq(provider) === providerId && !!baseUrl && sameBase(baseUrl, ourBaseUrl),
    baseUrl,
    model: unq(model),
    hasBackup: fs.existsSync(file + BACKUP_SUFFIX),
  };
}
