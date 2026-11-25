// 主进程 / 渲染进程 / CLI 共享的类型定义（仅类型，不产生运行时代码）

export type ModelKind = "chat" | "image" | "embeddings" | "other";

export interface CopilotModel {
  id: string;
  name: string;
  vendor: string;
  version?: string;
  kind: ModelKind;
  /** Copilot 上游声明支持的端点，如 /chat/completions、/responses、/v1/messages、/v1/images/generations */
  endpoints: string[];
  preview: boolean;
  pickerEnabled: boolean;
  /** enabled / disabled / unconfigured */
  policyState?: string;
  /** 高级请求倍率（premium request multiplier） */
  multiplier?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  supports: {
    tools?: boolean;
    vision?: boolean;
    streaming?: boolean;
    reasoning?: boolean;
    structuredOutputs?: boolean;
  };
  raw?: unknown;
}

export interface GithubUser {
  login: string;
  name?: string | null;
  avatarUrl?: string;
  /** 主进程下载并缓存的头像（data URL） */
  avatarDataUrl?: string;
}

export interface CopilotQuota {
  plan?: string;
  resetDate?: string;
  premium?: { entitlement: number; remaining: number; unlimited: boolean; percentRemaining?: number };
  chat?: { entitlement: number; remaining: number; unlimited: boolean };
}

export interface AdvancedSettings {
  editorVersion: string;
  editorPluginVersion: string;
  userAgent: string;
  integrationId: string;
  apiVersion: string;
  messagesApiVersion: string;
  /** 上游请求超时（毫秒），流式请求为首包超时 */
  upstreamTimeoutMs: number;
}

export interface Settings {
  /** 界面语言：auto 跟随系统 */
  language: "auto" | "zh" | "en";
  host: string;
  port: number;
  /** 本地访问密钥；为空则不校验（默认仅监听 127.0.0.1） */
  apiKey: string;
  autoStartProxy: boolean;
  launchAtLogin: boolean;
  startMinimized: boolean;
  /** 关闭窗口时最小化到托盘而不是退出 */
  closeToTray: boolean;
  /** Electron 下使用系统代理（net.fetch）访问 GitHub */
  useSystemProxy: boolean;
  /** 当请求的模型找不到时回退到此模型 */
  defaultModel: string;
  /** 生图默认模型（如 gpt-image-2.5-sunburst），为空则自动选择第一个可用的生图模型 */
  imageModel: string;
  /** Claude 模型且上游支持 /v1/messages 时直接透传（保留 thinking 签名等原生特性） */
  preferNativeMessages: boolean;
  /** 自定义模型别名：客户端请求名 -> Copilot 模型 id */
  modelAliases: Record<string, string>;
  claude: {
    model: string;
    opusModel: string;
    smallModel: string;
    disableNonEssentialTraffic: boolean;
  };
  codex: {
    model: string;
    reasoningEffort: "" | "minimal" | "low" | "medium" | "high" | "xhigh";
    providerId: string;
  };
  advanced: AdvancedSettings;
}

export interface LogEntry {
  id: number;
  time: number;
  method: string;
  path: string;
  requestedModel?: string;
  model?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  stream?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  initiator?: "user" | "agent";
  error?: string;
}

export interface DeviceLoginInfo {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

export type LoginState =
  | { status: "idle" }
  | { status: "pending"; info: DeviceLoginInfo }
  | { status: "success" }
  | { status: "error"; message: string };

export interface IntegrationStatus {
  configPath: string;
  exists: boolean;
  applied: boolean;
  /** 当前文件中指向的 base url（若有） */
  baseUrl?: string;
  model?: string;
  hasBackup: boolean;
}

export interface AppState {
  version: string;
  /** 解析后的界面语言 */
  lang: "zh" | "en";
  loggedIn: boolean;
  user?: GithubUser;
  quota?: CopilotQuota;
  apiBase?: string;
  tokenExpiresAt?: number;
  login: LoginState;
  proxy: { running: boolean; url: string; error?: string; startedAt?: number };
  models: CopilotModel[];
  modelsUpdatedAt?: number;
  modelsError?: string;
  settings: Settings;
  integrations: { claude: IntegrationStatus; codex: IntegrationStatus };
  stats: { requests: number; errors: number; inputTokens: number; outputTokens: number };
}

export interface ImageGenRequest {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  background?: string;
  /** 编辑模式：输入图片（data URL） */
  images?: string[];
}

export interface ImageGenResult {
  model: string;
  images: { dataUrl: string; revisedPrompt?: string }[];
  durationMs: number;
  savedPaths?: string[];
}
