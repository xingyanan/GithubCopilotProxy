import type { CopilotModel, ModelKind, Settings } from "../shared/types";
import { ENDPOINT } from "./constants";

/** 把 Copilot /models 的原始条目转换为统一结构 */
export function parseModels(raw: any): CopilotModel[] {
  const list: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  const seen = new Map<string, CopilotModel>();
  for (const m of list) {
    if (!m?.id) continue;
    const caps = m.capabilities ?? {};
    const supports = caps.supports ?? {};
    const limits = caps.limits ?? {};
    const type: string = caps.type ?? "";
    let endpoints: string[] = Array.isArray(m.supported_endpoints) ? m.supported_endpoints.map(String) : [];
    let kind: ModelKind;
    if (endpoints.some((e) => e.includes("/images/")) || type === "image" || type === "images") kind = "image";
    else if (type === "embeddings" || endpoints.some((e) => e.includes("embeddings"))) kind = "embeddings";
    else if (type === "chat" || endpoints.some((e) => [ENDPOINT.chat, ENDPOINT.responses, ENDPOINT.messages].includes(e as any))) kind = "chat";
    else kind = "other";
    if (endpoints.length === 0) {
      if (kind === "chat") endpoints = [ENDPOINT.chat];
      else if (kind === "embeddings") endpoints = [ENDPOINT.embeddings];
      else if (kind === "image") endpoints = [ENDPOINT.imagesGen];
    }
    const model: CopilotModel = {
      id: m.id,
      name: m.name ?? m.id,
      vendor: m.vendor ?? "",
      version: m.version,
      kind,
      endpoints,
      preview: !!m.preview,
      pickerEnabled: m.model_picker_enabled !== false,
      policyState: m.policy?.state,
      multiplier: typeof m.billing?.multiplier === "number" ? m.billing.multiplier : undefined,
      contextWindow: limits.max_context_window_tokens ?? limits.max_prompt_tokens,
      maxOutputTokens: limits.max_output_tokens,
      supports: {
        tools: !!supports.tool_calls,
        vision: !!supports.vision || !!limits.vision,
        streaming: supports.streaming !== false,
        reasoning: !!(supports.reasoning_effort || supports.adaptive_thinking || supports.max_thinking_budget || supports.thinking),
        structuredOutputs: !!supports.structured_outputs,
      },
      raw: m,
    };
    const prev = seen.get(model.id);
    // 重复条目时保留 picker 可见 / 端点更多的那个
    if (!prev || (!prev.pickerEnabled && model.pickerEnabled) || model.endpoints.length > prev.endpoints.length) seen.set(model.id, model);
  }
  return [...seen.values()].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.vendor.localeCompare(b.vendor) || a.id.localeCompare(b.id));
}

const kindOrder = (k: ModelKind) => ({ chat: 0, image: 1, embeddings: 2, other: 3 }[k]);

export function supportsEndpoint(m: CopilotModel | undefined, ep: string): boolean {
  if (!m) return ep === ENDPOINT.chat; // 未知模型默认按 chat 处理
  return m.endpoints.includes(ep);
}

function normalize(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "") // claude code 的 "[1m]" 等后缀
    .replace(/^(anthropic|openai|google|github|copilot)[/:]/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "")
    .replace(/(\d)-(\d)(?!\d)/g, "$1.$2");
}

export interface Resolved {
  id: string;
  model?: CopilotModel;
  /** 请求名与最终模型不同（别名 / 归一化 / 回退） */
  mapped: boolean;
}

/** 将客户端请求的模型名解析为 Copilot 上可用的模型 */
export function resolveModel(requested: string | undefined, kind: "chat" | "image" | "embeddings", models: CopilotModel[], settings: Settings): Resolved {
  const req = (requested ?? "").trim();
  const byId = new Map(models.map((m) => [m.id.toLowerCase(), m]));
  const ok = (m?: CopilotModel) => !!m && m.kind === kind && m.policyState !== "disabled";
  const hit = (id: string | undefined, mapped: boolean): Resolved | undefined => {
    if (!id) return undefined;
    const m = byId.get(id.toLowerCase());
    if (ok(m)) return { id: m!.id, model: m, mapped };
    return undefined;
  };

  // 1. 自定义别名
  const alias = settings.modelAliases?.[req] ?? settings.modelAliases?.[req.toLowerCase()];
  const a = hit(alias, true);
  if (a) return a;

  // 2. 精确匹配
  const exact = hit(req, false);
  if (exact) return exact;

  // 3. 归一化匹配（claude-sonnet-4-5-20250929 -> claude-sonnet-4.5）
  if (req) {
    const n = normalize(req);
    const direct = hit(n, true);
    if (direct) return direct;
    const candidates = models.filter((m) => ok(m)).filter((m) => {
      const mid = normalize(m.id);
      return n.startsWith(mid + "-") || mid.startsWith(n + "-") || mid === n;
    });
    if (candidates.length) {
      candidates.sort((x, y) => y.id.length - x.id.length);
      return { id: candidates[0].id, model: candidates[0], mapped: true };
    }
  }

  if (models.length === 0) return { id: req, mapped: false }; // 模型列表未加载时原样透传

  // 4. 回退
  if (kind === "image") {
    const fb = hit(settings.imageModel, true) ?? firstOf(models, "image");
    if (fb) return fb;
  } else if (kind === "chat") {
    const low = req.toLowerCase();
    if (/haiku|mini|small|fast/.test(low)) {
      const s = hit(settings.claude.smallModel, true);
      if (s) return s;
    }
    if (/opus/.test(low)) {
      const o = hit(settings.claude.opusModel, true);
      if (o) return o;
    }
    const fb = hit(settings.defaultModel, true) ?? hit(settings.claude.model, true) ?? firstOf(models, "chat");
    if (fb) return fb;
  } else {
    const fb = firstOf(models, "embeddings");
    if (fb) return fb;
  }
  return { id: req, mapped: false };
}

function firstOf(models: CopilotModel[], kind: ModelKind): Resolved | undefined {
  const m = models.find((x) => x.kind === kind && x.pickerEnabled && x.policyState !== "disabled") ?? models.find((x) => x.kind === kind && x.policyState !== "disabled");
  return m ? { id: m.id, model: m, mapped: true } : undefined;
}

/** OpenAI 风格 /v1/models 输出 */
export function toOpenAIModelList(models: CopilotModel[]) {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: m.vendor || "github-copilot",
      display_name: m.name,
      type: m.kind,
      supported_endpoints: m.endpoints,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens,
      capabilities: m.supports,
      preview: m.preview,
      premium_multiplier: m.multiplier,
    })),
  };
}

/** Anthropic 风格 /v1/models 输出（Claude Code 的 /model 列表等使用） */
export function toAnthropicModelList(models: CopilotModel[]) {
  const data = models.filter((m) => m.kind === "chat").map((m) => ({
    type: "model",
    id: m.id,
    display_name: m.name,
    created_at: "2025-01-01T00:00:00Z",
  }));
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null };
}
