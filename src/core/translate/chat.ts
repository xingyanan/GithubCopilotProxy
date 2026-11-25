/**
 * OpenAI Chat Completions 作为“规范请求格式”。
 * - 输出：NormEvent -> chat.completion(.chunk)
 * - 上游适配：chat 请求 -> Responses 请求 / Anthropic Messages 请求
 */
import type { NormEvent, NormResult } from "./norm";
import { genId } from "./norm";
import { sseData } from "../sse";

// ---------------- 输出（给 chat 客户端） ----------------

export async function* normToChatSSE(events: AsyncIterable<NormEvent>, model: string): AsyncGenerator<string> {
  const id = genId("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  const base = (delta: any, finish: string | null = null, extra: any = {}) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
  });
  let first = true;
  const withRole = (d: any) => { if (first) { first = false; return { role: "assistant", ...d }; } return d; };
  for await (const e of events) {
    switch (e.t) {
      case "text": yield sseData(base(withRole({ content: e.v }))); break;
      case "reasoning": yield sseData(base(withRole({ reasoning_content: e.v }))); break;
      case "tool_start":
        yield sseData(base(withRole({ tool_calls: [{ index: e.i, id: e.id, type: "function", function: { name: e.name, arguments: "" } }] })));
        break;
      case "tool_args":
        yield sseData(base({ tool_calls: [{ index: e.i, function: { arguments: e.v } }] }));
        break;
      case "done":
        if (first) yield sseData(base(withRole({ content: "" })));
        yield sseData(base({}, e.finish));
        if (e.usage) {
          yield sseData({ id, object: "chat.completion.chunk", created, model, choices: [], usage: toChatUsage(e.usage) });
        }
        break;
    }
  }
  yield "data: [DONE]\n\n";
}

export function normToChatJSON(r: NormResult, model: string) {
  const message: any = { role: "assistant", content: r.text || (r.toolCalls.length ? null : "") };
  if (r.reasoning) message.reasoning_content = r.reasoning;
  if (r.toolCalls.length) {
    message.tool_calls = r.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args || "{}" } }));
  }
  return {
    id: genId("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: r.finish }],
    usage: r.usage ? toChatUsage(r.usage) : undefined,
  };
}

function toChatUsage(u: NonNullable<NormResult["usage"]>) {
  return {
    prompt_tokens: u.input,
    completion_tokens: u.output,
    total_tokens: u.input + u.output,
    prompt_tokens_details: u.cached !== undefined ? { cached_tokens: u.cached } : undefined,
    completion_tokens_details: u.reasoning !== undefined ? { reasoning_tokens: u.reasoning } : undefined,
  };
}

// ---------------- 公共辅助 ----------------

export function contentToText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text ?? p?.content ?? (p?.type === "refusal" ? p.refusal : "")))
      .filter((s) => typeof s === "string")
      .join("");
  }
  return typeof content === "object" ? String(content.text ?? "") : String(content);
}

export function chatHasImages(messages: any[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url"));
}

/** 最后一条消息是用户的新输入 -> user，否则（工具结果/续写）-> agent，影响 Copilot 高级请求计费 */
export function chatInitiator(messages: any[]): "user" | "agent" {
  const last = messages[messages.length - 1];
  return last && last.role === "user" ? "user" : "agent";
}

// ---------------- 上游适配：chat -> Responses ----------------

export function chatToResponsesRequest(req: any, model: string): any {
  const instructions: string[] = [];
  const input: any[] = [];
  for (const m of req.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      instructions.push(contentToText(m.content));
    } else if (m.role === "user") {
      input.push({ type: "message", role: "user", content: userPartsToResponses(m.content) });
    } else if (m.role === "assistant") {
      const text = contentToText(m.content);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" });
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: contentToText(m.content) });
    }
  }
  const out: any = {
    model,
    input,
    stream: true,
    store: false,
  };
  if (instructions.length) out.instructions = instructions.join("\n\n");
  if (req.tools?.length) {
    out.tools = req.tools
      .filter((t: any) => t.type === "function" && t.function?.name)
      .map((t: any) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters ?? { type: "object", properties: {} },
        strict: false,
      }));
  }
  if (req.tool_choice) {
    out.tool_choice = typeof req.tool_choice === "string" ? req.tool_choice : { type: "function", name: req.tool_choice.function?.name };
  }
  if (req.parallel_tool_calls !== undefined) out.parallel_tool_calls = req.parallel_tool_calls;
  const max = req.max_completion_tokens ?? req.max_tokens;
  if (max) out.max_output_tokens = max;
  if (req.reasoning_effort) out.reasoning = { effort: req.reasoning_effort, summary: "auto" };
  if (req.response_format?.type === "json_schema") {
    const js = req.response_format.json_schema ?? {};
    out.text = { format: { type: "json_schema", name: js.name ?? "output", schema: js.schema, strict: js.strict ?? false } };
  } else if (req.response_format?.type === "json_object") {
    out.text = { format: { type: "json_object" } };
  }
  return out;
}

function userPartsToResponses(content: any): any[] {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  const parts: any[] = [];
  for (const p of content ?? []) {
    if (p.type === "text") parts.push({ type: "input_text", text: p.text });
    else if (p.type === "image_url") parts.push({ type: "input_image", image_url: p.image_url?.url ?? p.image_url, detail: p.image_url?.detail ?? "auto" });
  }
  return parts;
}

// ---------------- 上游适配：chat -> Anthropic Messages ----------------

export function chatToAnthropicRequest(req: any, model: string, defaultMaxTokens: number): any {
  const system: string[] = [];
  const messages: any[] = [];
  const push = (role: "user" | "assistant", blocks: any[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of req.messages ?? []) {
    if (m.role === "system" || m.role === "developer") system.push(contentToText(m.content));
    else if (m.role === "user") push("user", userPartsToAnthropic(m.content));
    else if (m.role === "assistant") {
      const blocks: any[] = [];
      const text = contentToText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls ?? []) {
        let input: any = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = { _raw: tc.function?.arguments }; }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: contentToText(m.content) }]);
    }
  }
  // tool_result 必须位于 user 消息开头
  for (const m of messages) {
    if (m.role === "user") m.content.sort((a: any, b: any) => (a.type === "tool_result" ? 0 : 1) - (b.type === "tool_result" ? 0 : 1));
  }
  const out: any = {
    model,
    messages,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? defaultMaxTokens,
    stream: true,
  };
  if (system.length) out.system = system.join("\n\n");
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined && req.temperature === undefined) out.top_p = req.top_p;
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.tools?.length) {
    out.tools = req.tools
      .filter((t: any) => t.type === "function" && t.function?.name)
      .map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
  }
  if (req.tool_choice && out.tools?.length) {
    const tc = req.tool_choice;
    if (tc === "required") out.tool_choice = { type: "any" };
    else if (tc === "none") out.tool_choice = { type: "none" };
    else if (tc === "auto") out.tool_choice = { type: "auto" };
    else if (tc?.function?.name) out.tool_choice = { type: "tool", name: tc.function.name };
    if (req.parallel_tool_calls === false && out.tool_choice) out.tool_choice.disable_parallel_tool_use = true;
  }
  return out;
}

function userPartsToAnthropic(content: any): any[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const blocks: any[] = [];
  for (const p of content ?? []) {
    if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
    else if (p.type === "image_url") {
      const url: string = p.image_url?.url ?? p.image_url;
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url ?? "");
      if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      else if (url) blocks.push({ type: "image", source: { type: "url", url } });
    }
  }
  return blocks;
}
