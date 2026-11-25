/**
 * Anthropic Messages API（Claude Code 使用）<-> 规范 chat 请求 / NormEvent
 */
import type { CopilotModel } from "../../shared/types";
import type { NormEvent, NormResult } from "./norm";
import { genId } from "./norm";
import { sseEvent } from "../sse";

const blockText = (c: any): string => {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === "text" ? b.text : typeof b === "string" ? b : "")).join("");
  return "";
};

/** Anthropic 请求 -> OpenAI chat 请求 */
export function anthropicToChatRequest(req: any, model: string, info?: CopilotModel): any {
  const messages: any[] = [];
  const sys = blockText(req.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of req.messages ?? []) {
    const blocks: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
    if (m.role === "user") {
      const parts: any[] = [];
      const pendingImages: any[] = [];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          // 工具结果 -> tool 消息（必须紧跟 assistant 的 tool_calls）
          const inner = typeof b.content === "string" ? [{ type: "text", text: b.content }] : b.content ?? [];
          const text = inner.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
          for (const x of inner) if (x.type === "image") pendingImages.push(imageToPart(x));
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "[ERROR] " : "") + (text || (pendingImages.length ? "(see images below)" : "")) });
        } else if (b.type === "text") {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
          const p = imageToPart(b);
          if (p) parts.push(p);
        } else if (b.type === "document" && b.source?.type === "text") {
          parts.push({ type: "text", text: b.source.data });
        }
      }
      const all = [...pendingImages.filter(Boolean), ...parts];
      if (all.length) {
        const onlyText = all.every((p) => p.type === "text");
        messages.push({ role: "user", content: onlyText ? all.map((p) => p.text).join("\n\n") : all });
      }
    } else if (m.role === "assistant") {
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const toolCalls = blocks
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: any = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (text || toolCalls.length) messages.push(msg);
    }
  }

  const out: any = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (req.max_tokens) out.max_tokens = info?.maxOutputTokens ? Math.min(req.max_tokens, info.maxOutputTokens) : req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;

  const tools = (req.tools ?? []).filter((t: any) => t.input_schema && t.name);
  if (tools.length) {
    out.tools = tools.map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.input_schema },
    }));
    const tc = req.tool_choice;
    if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "none") out.tool_choice = "none";
    else if (tc?.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc?.type === "auto") out.tool_choice = "auto";
    if (tc?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  // 非 Claude 推理模型：把 thinking 预算映射为 reasoning_effort
  if (req.thinking?.type === "enabled" && info?.supports.reasoning && !/claude/i.test(model)) {
    const b = req.thinking.budget_tokens ?? 0;
    out.reasoning_effort = b >= 16000 ? "high" : b >= 4000 ? "medium" : "low";
  }
  return out;
}

function imageToPart(b: any): any | undefined {
  const s = b.source ?? {};
  if (s.type === "base64") return { type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  if (s.type === "url") return { type: "image_url", image_url: { url: s.url } };
  return undefined;
}

export function anthropicHasImages(req: any): boolean {
  const scan = (c: any): boolean => Array.isArray(c) && c.some((b) => b?.type === "image" || (b?.type === "tool_result" && scan(b.content)));
  return (req.messages ?? []).some((m: any) => scan(m.content));
}

/** 最后一条 user 消息只包含 tool_result -> agent（工具循环中的续写，不计为新的用户请求） */
export function anthropicInitiator(req: any): "user" | "agent" {
  const msgs = req.messages ?? [];
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "user") return "agent";
  if (typeof last.content === "string") return "user";
  const blocks = last.content ?? [];
  return blocks.some((b: any) => b.type !== "tool_result") ? "user" : "agent";
}

const stopReason = (f: NormResult["finish"]) =>
  f === "length" ? "max_tokens" : f === "tool_calls" ? "tool_use" : f === "content_filter" ? "refusal" : "end_turn";

/** NormEvent -> Anthropic SSE */
export async function* normToAnthropicSSE(events: AsyncIterable<NormEvent>, model: string, estInput = 0): AsyncGenerator<string> {
  const id = genId("msg_");
  yield sseEvent("message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estInput, output_tokens: 1 } },
  });
  yield sseEvent("ping", { type: "ping" });
  let idx = -1;
  let open: { kind: "text" | "thinking" | "tool"; tool?: number } | undefined;
  const close = function* () {
    if (open) {
      if (open.kind === "thinking") yield sseEvent("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: "" } });
      yield sseEvent("content_block_stop", { type: "content_block_stop", index: idx });
      open = undefined;
    }
  };
  for await (const e of events) {
    if (e.t === "text") {
      if (open?.kind !== "text") {
        yield* close();
        idx++;
        open = { kind: "text" };
        yield sseEvent("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      }
      yield sseEvent("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: e.v } });
    } else if (e.t === "reasoning") {
      if (open?.kind !== "thinking") {
        yield* close();
        idx++;
        open = { kind: "thinking" };
        yield sseEvent("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "", signature: "" } });
      }
      yield sseEvent("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: e.v } });
    } else if (e.t === "tool_start") {
      yield* close();
      idx++;
      open = { kind: "tool", tool: e.i };
      yield sseEvent("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: e.id, name: e.name, input: {} } });
    } else if (e.t === "tool_args") {
      if (open?.kind === "tool" && open.tool === e.i) {
        yield sseEvent("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: e.v } });
      }
    } else if (e.t === "done") {
      yield* close();
      yield sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason(e.finish), stop_sequence: null },
        usage: {
          input_tokens: e.usage ? e.usage.input - (e.usage.cached ?? 0) : estInput,
          output_tokens: e.usage?.output ?? 0,
          cache_read_input_tokens: e.usage?.cached ?? 0,
        },
      });
      yield sseEvent("message_stop", { type: "message_stop" });
    }
  }
}

export function normToAnthropicJSON(r: NormResult, model: string) {
  const content: any[] = [];
  if (r.reasoning) content.push({ type: "thinking", thinking: r.reasoning, signature: "" });
  if (r.text) content.push({ type: "text", text: r.text });
  for (const t of r.toolCalls) {
    let input: any = {};
    try { input = JSON.parse(t.args || "{}"); } catch { input = { _raw: t.args }; }
    content.push({ type: "tool_use", id: t.id, name: t.name, input });
  }
  return {
    id: genId("msg_"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(r.finish),
    stop_sequence: null,
    usage: {
      input_tokens: r.usage ? r.usage.input - (r.usage.cached ?? 0) : 0,
      output_tokens: r.usage?.output ?? 0,
      cache_read_input_tokens: r.usage?.cached ?? 0,
    },
  };
}

export function anthropicError(status: number, message: string) {
  const type =
    status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 403 ? "permission_error" :
    status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error";
  return { type: "error", error: { type, message } };
}

/** 粗略估算 token 数（count_tokens 端点使用；Copilot 无对应接口） */
export function estimateAnthropicTokens(req: any): number {
  let chars = 0;
  let images = 0;
  const walk = (v: any) => {
    if (v == null) return;
    if (typeof v === "string") { chars += v.length; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "object") {
      if (v.type === "image") { images++; return; }
      for (const [k, x] of Object.entries(v)) if (k !== "signature") walk(x);
    }
  };
  walk(req.system);
  walk(req.messages);
  walk(req.tools);
  // 中文约 1 字/token，英文约 4 字符/token，这里取折中
  return Math.ceil(chars / 3.2) + images * 1500;
}
