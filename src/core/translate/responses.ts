/**
 * OpenAI Responses API（Codex 使用）<-> 规范 chat 请求 / NormEvent
 * 用于把 Codex 的请求转给只支持 /chat/completions 或 /v1/messages 的模型（如 Claude、Gemini）。
 */
import type { CopilotModel } from "../../shared/types";
import type { NormEvent, NormResult, Usage } from "./norm";
import { genId } from "./norm";
import { sseEvent } from "../sse";
import { HOSTED_TOOL_TYPES } from "../constants";

const partsText = (content: any): string => {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return "";
};

export interface ResponsesConversion {
  chat: any;
  /** Codex 的 freeform(custom) 工具名；在 chat 侧以 {input:string} 函数模拟 */
  customTools: Set<string>;
}

export function responsesToChatRequest(req: any, model: string, info?: CopilotModel): ResponsesConversion {
  const messages: any[] = [];
  const customTools = new Set<string>();
  for (const t of req.tools ?? []) if (t.type === "custom" && t.name) customTools.add(t.name);

  if (req.instructions) messages.push({ role: "system", content: req.instructions });

  const lastAssistantForTools = () => {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant") return last;
    const m: any = { role: "assistant", content: null };
    messages.push(m);
    return m;
  };

  const input = typeof req.input === "string" ? [{ type: "message", role: "user", content: req.input }] : req.input ?? [];
  for (const item of input) {
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      const role = item.role === "developer" || item.role === "system" ? "system" : item.role;
      if (role === "assistant") {
        const text = partsText(item.content);
        if (!text) continue;
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && !last.tool_calls) last.content = (last.content ?? "") + text;
        else messages.push({ role: "assistant", content: text });
      } else if (role === "system") {
        messages.push({ role: "system", content: partsText(item.content) });
      } else {
        messages.push({ role: "user", content: userContent(item.content) });
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      const m = lastAssistantForTools();
      m.tool_calls = m.tool_calls ?? [];
      const args = type === "custom_tool_call" ? JSON.stringify({ input: item.input ?? "" }) : item.arguments ?? "{}";
      m.tool_calls.push({ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: args } });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const out = item.output;
      let text: string;
      if (typeof out === "string") text = out;
      else if (Array.isArray(out)) text = out.map((p: any) => p.text ?? "").join("");
      else if (out && typeof out === "object") text = out.content ?? JSON.stringify(out);
      else text = String(out ?? "");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: text });
    } else if (type === "local_shell_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id ?? item.id, content: String(item.output ?? "") });
    }
    // reasoning / web_search_call 等条目在 chat 协议中无对应，忽略
  }

  const chat: any = { model, messages, stream: true, stream_options: { include_usage: true } };
  const max = req.max_output_tokens;
  if (max) chat.max_tokens = info?.maxOutputTokens ? Math.min(max, info.maxOutputTokens) : max;
  if (req.temperature !== undefined) chat.temperature = req.temperature;
  if (req.top_p !== undefined) chat.top_p = req.top_p;
  if (req.parallel_tool_calls !== undefined && (req.tools ?? []).length) chat.parallel_tool_calls = req.parallel_tool_calls;
  if (req.reasoning?.effort && info?.supports.reasoning && !/claude/i.test(model)) {
    chat.reasoning_effort = req.reasoning.effort === "minimal" ? "low" : req.reasoning.effort === "xhigh" ? "high" : req.reasoning.effort;
  }

  const tools: any[] = [];
  for (const t of req.tools ?? []) {
    if (t.type === "function" && t.name) {
      tools.push({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } });
    } else if (t.type === "custom" && t.name) {
      const fmt = t.format?.definition ? `\n\nThe input must follow this ${t.format.syntax ?? "grammar"} grammar:\n${t.format.definition}` : "";
      tools.push({
        type: "function",
        function: {
          name: t.name,
          description: (t.description ?? "") + fmt,
          parameters: { type: "object", properties: { input: { type: "string", description: "Raw text input for the tool" } }, required: ["input"] },
        },
      });
    }
  }
  if (tools.length) {
    chat.tools = tools;
    const tc = req.tool_choice;
    if (tc === "auto" || tc === "none" || tc === "required") chat.tool_choice = tc;
    else if (tc?.name) chat.tool_choice = { type: "function", function: { name: tc.name } };
  }
  const fmt = req.text?.format;
  if (fmt?.type === "json_schema") chat.response_format = { type: "json_schema", json_schema: { name: fmt.name ?? "output", schema: fmt.schema, strict: fmt.strict ?? false } };
  else if (fmt?.type === "json_object") chat.response_format = { type: "json_object" };
  return { chat, customTools };
}

function userContent(content: any): any {
  if (typeof content === "string") return content;
  const parts: any[] = [];
  for (const p of content ?? []) {
    if (p.type === "input_text" || p.type === "text" || p.type === "output_text") parts.push({ type: "text", text: p.text });
    else if (p.type === "input_image") {
      const url = p.image_url ?? p.url;
      if (url) parts.push({ type: "image_url", image_url: { url, detail: p.detail } });
    } else if (p.type === "input_file" && p.file_data) {
      parts.push({ type: "text", text: `[attachment ${p.filename ?? ""}]` });
    }
  }
  if (parts.every((p) => p.type === "text")) return parts.map((p) => p.text).join("\n");
  return parts;
}

export function responsesHasImages(req: any): boolean {
  if (!Array.isArray(req.input)) return false;
  return req.input.some((it: any) => Array.isArray(it.content) && it.content.some((p: any) => p?.type === "input_image"));
}

export function responsesInitiator(req: any): "user" | "agent" {
  if (typeof req.input === "string") return "user";
  const items = req.input ?? [];
  const last = items[items.length - 1];
  if (!last) return "user";
  const type = last.type ?? (last.role ? "message" : "");
  return type === "message" && last.role === "user" ? "user" : "agent";
}

/** 透传到 Copilot /responses 前，剥离上游不支持的托管工具 */
export function stripHostedTools(req: any): string[] {
  const removed: string[] = [];
  if (Array.isArray(req.tools)) {
    req.tools = req.tools.filter((t: any) => {
      if (HOSTED_TOOL_TYPES.has(t?.type)) { removed.push(t.type); return false; }
      return true;
    });
    if (!req.tools.length) { delete req.tools; delete req.tool_choice; delete req.parallel_tool_calls; }
  }
  return removed;
}

// ---------------- 输出（给 Responses 客户端） ----------------

const usageObj = (u?: Usage) =>
  u
    ? {
        input_tokens: u.input,
        input_tokens_details: { cached_tokens: u.cached ?? 0 },
        output_tokens: u.output,
        output_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
        total_tokens: u.input + u.output,
      }
    : undefined;

function baseResponse(id: string, model: string, req: any, status: string, output: any[], usage?: Usage, incomplete?: string) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: req?.parallel_tool_calls ?? true,
    tool_choice: req?.tool_choice ?? "auto",
    tools: req?.tools ?? [],
    store: false,
    incomplete_details: incomplete ? { reason: incomplete } : null,
    error: null,
    usage: usageObj(usage),
  };
}

function toolItem(id: string, callId: string, name: string, args: string, custom: boolean, status = "completed") {
  if (custom) {
    let input = args;
    try { const j = JSON.parse(args || "{}"); input = typeof j.input === "string" ? j.input : args; } catch {}
    return { type: "custom_tool_call", id, call_id: callId, name, input, status };
  }
  return { type: "function_call", id, call_id: callId, name, arguments: args || "{}", status };
}

export async function* normToResponsesSSE(events: AsyncIterable<NormEvent>, model: string, req: any, customTools: Set<string>): AsyncGenerator<string> {
  const respId = genId("resp_");
  let seq = 0;
  const ev = (type: string, payload: any) => sseEvent(type, { type, sequence_number: seq++, ...payload });
  yield ev("response.created", { response: baseResponse(respId, model, req, "in_progress", []) });
  yield ev("response.in_progress", { response: baseResponse(respId, model, req, "in_progress", []) });

  const output: any[] = [];
  type Open =
    | { kind: "text"; id: string; idx: number; text: string }
    | { kind: "reasoning"; id: string; idx: number; text: string }
    | { kind: "tool"; id: string; idx: number; callId: string; name: string; args: string; custom: boolean; i: number };
  let open: Open | undefined;

  const close = function* (): Generator<string> {
    if (!open) return;
    const o = open;
    open = undefined;
    if (o.kind === "text") {
      yield ev("response.output_text.done", { item_id: o.id, output_index: o.idx, content_index: 0, text: o.text });
      const part = { type: "output_text", text: o.text, annotations: [] };
      yield ev("response.content_part.done", { item_id: o.id, output_index: o.idx, content_index: 0, part });
      const item = { type: "message", id: o.id, role: "assistant", status: "completed", content: [part] };
      output[o.idx] = item;
      yield ev("response.output_item.done", { output_index: o.idx, item });
    } else if (o.kind === "reasoning") {
      yield ev("response.reasoning_summary_text.done", { item_id: o.id, output_index: o.idx, summary_index: 0, text: o.text });
      yield ev("response.reasoning_summary_part.done", { item_id: o.id, output_index: o.idx, summary_index: 0, part: { type: "summary_text", text: o.text } });
      const item = { type: "reasoning", id: o.id, summary: [{ type: "summary_text", text: o.text }] };
      output[o.idx] = item;
      yield ev("response.output_item.done", { output_index: o.idx, item });
    } else {
      const item = toolItem(o.id, o.callId, o.name, o.args, o.custom);
      if (!o.custom) yield ev("response.function_call_arguments.done", { item_id: o.id, output_index: o.idx, arguments: o.args || "{}" });
      else yield ev("response.custom_tool_call_input.done", { item_id: o.id, output_index: o.idx, input: (item as any).input });
      output[o.idx] = item;
      yield ev("response.output_item.done", { output_index: o.idx, item });
    }
  };

  for await (const e of events) {
    if (e.t === "text") {
      if (open?.kind !== "text") {
        yield* close();
        const o: Open = { kind: "text", id: genId("msg_"), idx: output.length, text: "" };
        output.push(null);
        open = o;
        yield ev("response.output_item.added", { output_index: o.idx, item: { type: "message", id: o.id, role: "assistant", status: "in_progress", content: [] } });
        yield ev("response.content_part.added", { item_id: o.id, output_index: o.idx, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      }
      (open as any).text += e.v;
      yield ev("response.output_text.delta", { item_id: open!.id, output_index: open!.idx, content_index: 0, delta: e.v });
    } else if (e.t === "reasoning") {
      if (open?.kind !== "reasoning") {
        yield* close();
        const o: Open = { kind: "reasoning", id: genId("rs_"), idx: output.length, text: "" };
        output.push(null);
        open = o;
        yield ev("response.output_item.added", { output_index: o.idx, item: { type: "reasoning", id: o.id, summary: [] } });
        yield ev("response.reasoning_summary_part.added", { item_id: o.id, output_index: o.idx, summary_index: 0, part: { type: "summary_text", text: "" } });
      }
      (open as any).text += e.v;
      yield ev("response.reasoning_summary_text.delta", { item_id: open!.id, output_index: open!.idx, summary_index: 0, delta: e.v });
    } else if (e.t === "tool_start") {
      yield* close();
      const custom = customTools.has(e.name);
      const o: Open = { kind: "tool", id: genId("fc_"), idx: output.length, callId: e.id, name: e.name, args: "", custom, i: e.i };
      output.push(null);
      open = o;
      yield ev("response.output_item.added", { output_index: o.idx, item: { ...toolItem(o.id, o.callId, o.name, "", custom, "in_progress"), ...(custom ? { input: "" } : { arguments: "" }) } });
    } else if (e.t === "tool_args") {
      if (open?.kind === "tool" && open.i === e.i) {
        open.args += e.v;
        if (!open.custom) yield ev("response.function_call_arguments.delta", { item_id: open.id, output_index: open.idx, delta: e.v });
      }
    } else if (e.t === "done") {
      yield* close();
      const final = output.filter(Boolean);
      if (e.finish === "length") {
        yield ev("response.incomplete", { response: baseResponse(respId, model, req, "incomplete", final, e.usage, "max_output_tokens") });
      } else {
        yield ev("response.completed", { response: baseResponse(respId, model, req, "completed", final, e.usage) });
      }
    }
  }
}

export function normToResponsesJSON(r: NormResult, model: string, req: any, customTools: Set<string>) {
  const output: any[] = [];
  if (r.reasoning) output.push({ type: "reasoning", id: genId("rs_"), summary: [{ type: "summary_text", text: r.reasoning }] });
  if (r.text) output.push({ type: "message", id: genId("msg_"), role: "assistant", status: "completed", content: [{ type: "output_text", text: r.text, annotations: [] }] });
  for (const t of r.toolCalls) output.push(toolItem(genId("fc_"), t.id, t.name, t.args, customTools.has(t.name)));
  const res: any = baseResponse(genId("resp_"), model, req, r.finish === "length" ? "incomplete" : "completed", output, r.usage, r.finish === "length" ? "max_output_tokens" : undefined);
  res.output_text = r.text;
  return res;
}
