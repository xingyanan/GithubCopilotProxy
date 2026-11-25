import { randomUUID } from "node:crypto";
import type { AdvancedSettings, CopilotModel } from "../shared/types";
import { CopilotTokenManager, type FetchLike } from "./auth";
import { ENDPOINT } from "./constants";
import { parseModels } from "./models";

export interface UpstreamOptions {
  initiator?: "user" | "agent";
  vision?: boolean;
  /** 额外透传的头（anthropic-beta 等） */
  extraHeaders?: Record<string, string>;
  contentType?: string;
  signal?: AbortSignal;
  method?: string;
}

export class UpstreamError extends Error {
  constructor(public status: number, public body: string, public contentType = "application/json") {
    super(`Copilot upstream error HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

/** Copilot API 客户端：负责鉴权头、token 刷新、401 重试 */
export class CopilotClient {
  constructor(
    public tokens: CopilotTokenManager,
    private fetchFn: () => FetchLike,
    private adv: () => AdvancedSettings,
  ) {}

  headers(token: string, endpoint: string, opts: UpstreamOptions = {}): Record<string, string> {
    const a = this.adv();
    const h: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": opts.contentType ?? "application/json",
      accept: "application/json",
      "copilot-integration-id": a.integrationId,
      "editor-version": a.editorVersion,
      "editor-plugin-version": a.editorPluginVersion,
      "user-agent": a.userAgent,
      "openai-intent": "conversation-agent",
      "x-interaction-type": "conversation-agent",
      "x-github-api-version": endpoint === ENDPOINT.messages ? a.messagesApiVersion : a.apiVersion,
      "x-request-id": randomUUID(),
      "x-vscode-user-agent-library-version": "electron-fetch",
      "x-initiator": opts.initiator ?? "user",
    };
    if (opts.vision) h["copilot-vision-request"] = "true";
    if (endpoint === ENDPOINT.messages) h["anthropic-version"] = "2023-06-01";
    for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) if (v) h[k.toLowerCase()] = v;
    return h;
  }

  /**
   * 向 Copilot 发送请求。非 2xx 抛出 UpstreamError；遇到 401 自动刷新 token 重试一次。
   * 返回原始 Response，调用方自行决定透传或解析（流式）。
   */
  async request(endpoint: string, body: string | Buffer | undefined, opts: UpstreamOptions = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.tokens.get(attempt > 0);
      // 仅对“等待响应头”计时；响应开始后（流式）不再超时，由客户端断开来取消
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error("Timed out waiting for Copilot response")), this.adv().upstreamTimeoutMs);
      const signal = opts.signal ? anySignal([opts.signal, ctl.signal]) : ctl.signal;
      let res: Response;
      try {
        res = await this.fetchFn()(tok.apiBase + endpoint, {
          method: opts.method ?? (body === undefined ? "GET" : "POST"),
          headers: this.headers(tok.token, endpoint, opts),
          body: body as any,
          signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401 && attempt === 0) { await res.text().catch(() => {}); continue; }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new UpstreamError(res.status, text || res.statusText, res.headers.get("content-type") ?? "application/json");
      }
      return res;
    }
    throw new UpstreamError(401, "Invalid Copilot token");
  }

  async json(endpoint: string, body: unknown, opts: UpstreamOptions = {}): Promise<any> {
    const res = await this.request(endpoint, body === undefined ? undefined : JSON.stringify(body), opts);
    return res.json();
  }

  async listModels(): Promise<CopilotModel[]> {
    const j = await this.json("/models", undefined);
    return parseModels(j);
  }

  /** 部分模型需要先接受策略（policy state = unconfigured）才能使用 */
  async enableModel(id: string): Promise<void> {
    await this.json(`/models/${encodeURIComponent(id)}/policy`, { state: "enabled" });
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as any).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
