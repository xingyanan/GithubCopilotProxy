import type { Settings, AdvancedSettings } from "../shared/types";

/** VS Code Copilot 插件使用的 GitHub OAuth App client id（device flow） */
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_SCOPES = "read:user";
export const GITHUB_BASE = "https://github.com";
export const GITHUB_API = "https://api.github.com";
export const DEFAULT_COPILOT_API = "https://api.githubcopilot.com";

export const DEFAULT_ADVANCED: AdvancedSettings = {
  editorVersion: "vscode/1.107.0",
  editorPluginVersion: "copilot-chat/0.35.0",
  userAgent: "GitHubCopilotChat/0.35.0",
  integrationId: "vscode-chat",
  apiVersion: "2025-05-01",
  messagesApiVersion: "2026-06-01",
  upstreamTimeoutMs: 300_000,
};

export const DEFAULT_SETTINGS: Settings = {
  language: "auto",
  host: "127.0.0.1",
  port: 4141,
  apiKey: "",
  autoStartProxy: true,
  launchAtLogin: false,
  startMinimized: false,
  closeToTray: true,
  useSystemProxy: true,
  defaultModel: "",
  imageModel: "",
  preferNativeMessages: true,
  modelAliases: {},
  claude: {
    model: "",
    opusModel: "",
    smallModel: "",
    disableNonEssentialTraffic: true,
  },
  codex: {
    model: "",
    reasoningEffort: "",
    providerId: "copilot-proxy",
  },
  advanced: { ...DEFAULT_ADVANCED },
};

/** Responses API 中 Copilot 上游不支持、需要剥离的托管工具类型 */
export const HOSTED_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "image_generation",
  "file_search",
  "code_interpreter",
  "computer_use_preview",
  "local_shell",
  "mcp",
]);

export const ENDPOINT = {
  chat: "/chat/completions",
  responses: "/responses",
  messages: "/v1/messages",
  imagesGen: "/v1/images/generations",
  imagesEdit: "/v1/images/edits",
  embeddings: "/embeddings",
} as const;
