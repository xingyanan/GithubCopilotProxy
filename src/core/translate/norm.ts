/**
 * 统一的中间事件流（NormEvent）。
 * 任何上游（chat / responses / messages）的流式输出都先转换为 NormEvent，
 * 再由下游 writer 输出为客户端需要的协议格式。
 */
import { parseSSEJson } from "../sse";

export interface Usage {
  input: number;
  output: number;
  cached?: number;
  reasoning?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export type NormEvent =
  | { t: "text"; v: string }
  | { t: "reasoning"; v: string }
  | { t: "tool_start"; i: number; id: string; name: string }
  | { t: "tool_args"; i: number; v: string }
  | { t: "done"; finish: FinishReason; usage?: Usage };

export interface NormToolCall { id: string; name: string; args: string }

export interface NormResult {
  text: string;
  reasoning: string;
  toolCalls: NormToolCall[];
  finish: FinishReason;
  usage?: Usage;
}

export async function collect(events: AsyncIterable<NormEvent>): Promise<NormResult> {
  const r: NormResult = { text: "", reasoning: "", toolCalls: [], finish: "stop" };
  const byIdx = new Map<number, NormToolCall>();
  for await (const e of events) {
    switch (e.t) {
      case "text": r.text += e.v; break;
      case "reasoning": r.reasoning += e.v; break;
      case "tool_start": { const tc = { id: e.id, name: e.name, args: "" }; byIdx.set(e.i, tc); r.toolCalls.push(tc); break; }
      case "tool_args": { const tc = byIdx.get(e.i); if (tc) tc.args += e.v; break; }
      case "done": r.finish = e.finish; r.usage = e.usage; break;
    }
  }
  return r;
}

export const genId = (prefix: string) => prefix + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

/** OpenAI Chat Completions SSE -> NormEvent（兼容 Copilot 把文本与工具调用拆到不同 choice 的情况） */
export async function* chatStreamToNorm(body: ReadableStream<Uint8Array> | null): AsyncGenerator<NormEvent> {
  let finish: FinishReason | undefined;
  let usage: Usage | undefined;
  let nextIdx = 0;
  const tools = new Map<string, { i: number; id: string }>();
  let sawTool = false;
  for await (const { json } of parseSSEJson(body)) {
    if (json.error) throw new Error(typeof json.error === "string" ? json.error : json.error.message ?? JSON.stringify(json.error));
    if (json.usage) usage = chatUsage(json.usage);
    for (const ch of json.choices ?? []) {
      const d = ch.delta ?? ch.message ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning_text ?? d.reasoning;
      if (typeof reasoning === "string" && reasoning) yield { t: "reasoning", v: reasoning };
      if (typeof d.content === "string" && d.content) yield { t: "text", v: d.content };
      for (const tc of d.tool_calls ?? []) {
        const key = `${ch.index ?? 0}:${tc.index ?? 0}`;
        let cur = tools.get(key);
        if (tc.id && (!cur || cur.id !== tc.id)) {
          cur = { i: nextIdx++, id: tc.id };
          tools.set(key, cur);
          sawTool = true;
          yield { t: "tool_start", i: cur.i, id: tc.id, name: tc.function?.name ?? "" };
        }
        if (cur && tc.function?.arguments) yield { t: "tool_args", i: cur.i, v: tc.function.arguments };
      }
      if (ch.finish_reason) finish = mapChatFinish(ch.finish_reason);
    }
  }
  if (sawTool && (finish === undefined || finish === "stop")) finish = "tool_calls";
  yield { t: "done", finish: finish ?? "stop", usage };
}

export function chatUsage(u: any): Usage {
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens,
    reasoning: u.completion_tokens_details?.reasoning_tokens,
  };
}

function mapChatFinish(r: string): FinishReason {
  if (r === "length") return "length";
  if (r === "tool_calls" || r === "function_call") return "tool_calls";
  if (r === "content_filter") return "content_filter";
  return "stop";
}

/** OpenAI Responses SSE -> NormEvent */
export async function* responsesStreamToNorm(body: ReadableStream<Uint8Array> | null): AsyncGenerator<NormEvent> {
  let nextIdx = 0;
  const items = new Map<string, { i: number; streamed: boolean }>();
  let finish: FinishReason = "stop";
  let usage: Usage | undefined;
  let sawTool = false;
  for await (const { event, json } of parseSSEJson(body)) {
    const type = json.type ?? event;
    switch (type) {
      case "response.output_text.delta":
        if (json.delta) yield { t: "text", v: json.delta };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (json.delta) yield { t: "reasoning", v: json.delta };
        break;
      case "response.output_item.added": {
        const it = json.item ?? {};
        if (it.type === "function_call") {
          const i = nextIdx++;
          items.set(it.id ?? String(json.output_index), { i, streamed: false });
          sawTool = true;
          yield { t: "tool_start", i, id: it.call_id ?? it.id, name: it.name };
          if (it.arguments) { items.get(it.id ?? String(json.output_index))!.streamed = true; yield { t: "tool_args", i, v: it.arguments }; }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const rec = items.get(json.item_id) ?? items.get(String(json.output_index));
        if (rec && json.delta) { rec.streamed = true; yield { t: "tool_args", i: rec.i, v: json.delta }; }
        break;
      }
      case "response.output_item.done": {
        const it = json.item ?? {};
        if (it.type === "function_call") {
          const rec = items.get(it.id) ?? items.get(String(json.output_index));
          if (rec && !rec.streamed && it.arguments) yield { t: "tool_args", i: rec.i, v: it.arguments };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const r = json.response ?? {};
        if (r.usage) usage = responsesUsage(r.usage);
        if (type === "response.incomplete" || r.status === "incomplete") {
          finish = r.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
        }
        break;
      }
      case "response.failed":
      case "error": {
        const err = json.response?.error ?? json.error ?? json;
        throw new Error(err?.message ?? JSON.stringify(err));
      }
    }
  }
  if (sawTool && finish === "stop") finish = "tool_calls";
  yield { t: "done", finish, usage };
}

export function responsesUsage(u: any): Usage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cached: u.input_tokens_details?.cached_tokens,
    reasoning: u.output_tokens_details?.reasoning_tokens,
  };
}

/** Anthropic Messages SSE -> NormEvent */
export async function* anthropicStreamToNorm(body: ReadableStream<Uint8Array> | null): AsyncGenerator<NormEvent> {
  let nextIdx = 0;
  const blocks = new Map<number, number>(); // content block index -> tool idx
  let finish: FinishReason = "stop";
  const usage: Usage = { input: 0, output: 0 };
  for await (const { event, json } of parseSSEJson(body)) {
    const type = json.type ?? event;
    switch (type) {
      case "message_start": {
        const u = json.message?.usage ?? {};
        usage.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        usage.cached = u.cache_read_input_tokens;
        usage.output = u.output_tokens ?? 0;
        break;
      }
      case "content_block_start": {
        const cb = json.content_block ?? {};
        if (cb.type === "tool_use" || cb.type === "server_tool_use") {
          const i = nextIdx++;
          blocks.set(json.index, i);
          yield { t: "tool_start", i, id: cb.id, name: cb.name };
          if (cb.input && Object.keys(cb.input).length) yield { t: "tool_args", i, v: JSON.stringify(cb.input) };
        } else if (cb.type === "text" && cb.text) {
          yield { t: "text", v: cb.text };
        }
        break;
      }
      case "content_block_delta": {
        const d = json.delta ?? {};
        if (d.type === "text_delta" && d.text) yield { t: "text", v: d.text };
        else if (d.type === "thinking_delta" && d.thinking) yield { t: "reasoning", v: d.thinking };
        else if (d.type === "input_json_delta" && d.partial_json) {
          const i = blocks.get(json.index);
          if (i !== undefined) yield { t: "tool_args", i, v: d.partial_json };
        }
        break;
      }
      case "message_delta": {
        if (json.delta?.stop_reason) finish = mapAnthropicStop(json.delta.stop_reason);
        if (json.usage?.output_tokens !== undefined) usage.output = json.usage.output_tokens;
        if (json.usage?.input_tokens) usage.input = json.usage.input_tokens + (json.usage.cache_read_input_tokens ?? 0);
        break;
      }
      case "error":
        throw new Error(json.error?.message ?? JSON.stringify(json));
    }
  }
  yield { t: "done", finish, usage };
}

export function mapAnthropicStop(r: string): FinishReason {
  if (r === "max_tokens" || r === "model_context_window_exceeded") return "length";
  if (r === "tool_use") return "tool_calls";
  if (r === "refusal") return "content_filter";
  return "stop";
}
