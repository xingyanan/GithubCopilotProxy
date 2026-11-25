import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { CopilotModel, LogEntry, Settings } from "../shared/types";
import { CopilotClient, UpstreamError } from "./copilot";
import { NotLoggedInError } from "./auth";
import { RequestLog, debug } from "./logger";
import { ENDPOINT } from "./constants";
import { resolveModel, supportsEndpoint, toAnthropicModelList, toOpenAIModelList, type Resolved } from "./models";
import { collect, chatStreamToNorm, responsesStreamToNorm, anthropicStreamToNorm, type NormEvent } from "./translate/norm";
import { normToChatSSE, normToChatJSON, chatToResponsesRequest, chatToAnthropicRequest, chatHasImages, chatInitiator } from "./translate/chat";
import {
  anthropicToChatRequest, normToAnthropicSSE, normToAnthropicJSON, anthropicError, anthropicHasImages, anthropicInitiator, estimateAnthropicTokens,
} from "./translate/anthropic";
import { responsesToChatRequest, normToResponsesSSE, normToResponsesJSON, responsesHasImages, responsesInitiator, stripHostedTools } from "./translate/responses";
import { L } from "./i18n";

export interface ProxyDeps {
  client: CopilotClient;
  getModels(): Promise<CopilotModel[]>;
  settings(): Settings;
  log: RequestLog;
}

type Proto = "openai" | "anthropic";
type Upstream = "chat" | "responses" | "messages";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const MAX_BODY = 200 * 1024 * 1024;

/** 允许透传给 Copilot /v1/messages 的 anthropic-beta 特性（未知 beta 可能导致上游 400） */
const ALLOWED_BETAS = [/^interleaved-thinking/, /^fine-grained-tool-streaming/, /^context-1m/, /^token-efficient-tools/, /^context-management/];

export class ProxyServer {
  private server?: http.Server;
  private sockets = new Set<import("node:net").Socket>();

  constructor(private deps: ProxyDeps) {}

  get running() { return !!this.server?.listening; }

  get address(): string | undefined {
    const a = this.server?.address() as AddressInfo | null;
    if (!a) return undefined;
    const host = a.address === "::" || a.address === "0.0.0.0" ? "127.0.0.1" : a.address.includes(":") ? `[${a.address}]` : a.address;
    return `http://${host}:${a.port}`;
  }

  async start(host: string, port: number): Promise<string> {
    if (this.server) await this.stop();
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        debug("unhandled", e);
        if (!res.headersSent) sendJSON(res, 500, { error: { message: String(e?.message ?? e) } });
        else res.end();
      });
    });
    server.keepAliveTimeout = 65_000;
    server.requestTimeout = 0; // 长流式响应不超时
    server.headersTimeout = 70_000;
    server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: any) =>
        reject(
          e?.code === "EADDRINUSE" ? new Error(L(`端口 ${port} 已被其他程序占用，请在设置中更换端口`, `Port ${port} is already in use. Change the port in Settings.`)) :
          e?.code === "EACCES" ? new Error(L(`端口 ${port} 被系统保留或无权限使用，请在设置中更换端口`, `Port ${port} is reserved or not permitted. Change the port in Settings.`)) : e,
        );
      server.once("error", onErr);
      server.listen(port, host, () => { server.off("error", onErr); resolve(); });
    });
    this.server = server;
    return this.address!;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => s.close(() => r()));
  }

  // ---------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "") || "/";
    const proto: Proto = route.startsWith("/messages") ? "anthropic" : "openai";

    if (route === "/" || route === "/health") {
      sendJSON(res, 200, { ok: true, name: "copilot-proxy", endpoints: ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/images/generations", "/v1/images/edits", "/v1/embeddings"] });
      return;
    }

    const entry = this.deps.log.begin(req.method ?? "GET", url.pathname);
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) abort.abort(); });

    try {
      this.checkAuth(req);
      if (req.method === "GET" && route === "/models") {
        const models = await this.deps.getModels();
        const wantAnthropic = !!req.headers["anthropic-version"] || url.searchParams.get("format") === "anthropic";
        sendJSON(res, 200, wantAnthropic ? toAnthropicModelList(models) : toOpenAIModelList(models));
        entry.status = 200;
        return;
      }
      if (req.method !== "POST") throw new HttpError(404, `Unknown endpoint ${req.method} ${url.pathname}`);

      const raw = await readBody(req);
      switch (route) {
        case "/chat/completions": await this.chatCompletions(req, res, json(raw), entry, abort.signal); break;
        case "/responses": await this.responses(req, res, json(raw), entry, abort.signal); break;
        case "/messages": await this.messages(req, res, json(raw), entry, abort.signal); break;
        case "/messages/count_tokens": {
          const body = json(raw);
          entry.requestedModel = body.model;
          sendJSON(res, 200, { input_tokens: estimateAnthropicTokens(body) });
          entry.status = 200;
          break;
        }
        case "/images/generations": await this.images(req, res, raw, entry, ENDPOINT.imagesGen, abort.signal); break;
        case "/images/edits": await this.images(req, res, raw, entry, ENDPOINT.imagesEdit, abort.signal); break;
        case "/embeddings": await this.embeddings(res, json(raw), entry, abort.signal); break;
        default: throw new HttpError(404, `Unknown endpoint ${url.pathname}`);
      }
    } catch (e: any) {
      this.fail(res, proto, entry, e);
    } finally {
      if (entry.status === undefined) entry.status = res.statusCode;
      this.deps.log.finish(entry);
    }
  }

  private checkAuth(req: http.IncomingMessage) {
    const key = this.deps.settings().apiKey;
    if (!key) return;
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const xkey = String(req.headers["x-api-key"] ?? "");
    if (auth !== key && xkey !== key) throw new HttpError(401, "Invalid local API key");
  }

  private fail(res: http.ServerResponse, proto: Proto, entry: LogEntry, e: any) {
    let status = 500;
    let message = String(e?.message ?? e);
    if (e instanceof HttpError) status = e.status;
    else if (e instanceof NotLoggedInError) status = 401;
    else if (e instanceof UpstreamError) {
      status = e.status;
      message = extractUpstreamMessage(e.body);
    } else if (e?.name === "AbortError") { status = 499; message = "Client disconnected"; }
    entry.status = status;
    entry.error = message;
    if (res.headersSent) {
      try {
        if (proto === "anthropic") res.write(`event: error\ndata: ${JSON.stringify(anthropicError(status, message))}\n\n`);
        else res.write(`data: ${JSON.stringify({ error: { message, code: status } })}\n\n`);
      } catch {}
      res.end();
      return;
    }
    if (proto === "anthropic") sendJSON(res, status, anthropicError(status, message));
    else sendJSON(res, status, { error: { message, type: status === 401 ? "authentication_error" : "api_error", code: status } });
  }

  // ---------------------------------------------------------------------------
  // 通用：以规范 chat 请求调用上游（按模型支持的端点自动选择），返回 NormEvent 流

  private async upstreamNorm(chatReq: any, r: Resolved, opts: { initiator: "user" | "agent"; vision: boolean; signal: AbortSignal; exclude?: Upstream }, entry: LogEntry): Promise<AsyncIterable<NormEvent>> {
    const m = r.model;
    const order: Upstream[] = (["chat", "responses", "messages"] as Upstream[]).filter((u) => u !== opts.exclude);
    const target =
      order.find((u) => supportsEndpoint(m, u === "chat" ? ENDPOINT.chat : u === "responses" ? ENDPOINT.responses : ENDPOINT.messages)) ??
      (opts.exclude === "chat" ? "responses" : "chat");
    entry.route = (entry.route ? entry.route + "→" : "") + target;
    const common = { initiator: opts.initiator, vision: opts.vision, signal: opts.signal };
    let events: AsyncIterable<NormEvent>;
    if (target === "chat") {
      const body = { ...chatReq, model: r.id, stream: true, stream_options: { include_usage: true } };
      const up = await this.deps.client.request(ENDPOINT.chat, JSON.stringify(body), common);
      events = chatStreamToNorm(up.body);
    } else if (target === "responses") {
      const body = chatToResponsesRequest(chatReq, r.id);
      const up = await this.deps.client.request(ENDPOINT.responses, JSON.stringify(body), common);
      events = responsesStreamToNorm(up.body);
    } else {
      const body = chatToAnthropicRequest(chatReq, r.id, Math.min(m?.maxOutputTokens ?? 8192, 32000));
      const up = await this.deps.client.request(ENDPOINT.messages, JSON.stringify(body), common);
      events = anthropicStreamToNorm(up.body);
    }
    return tapUsage(events, entry);
  }

  private resolve(model: string | undefined, kind: "chat" | "image" | "embeddings", models: CopilotModel[], entry: LogEntry): Resolved {
    const r = resolveModel(model, kind, models, this.deps.settings());
    entry.requestedModel = model;
    entry.model = r.id;
    if (!r.id) throw new HttpError(400, "No model specified and no default model available");
    return r;
  }

  // ---------------------------------------------------------------------------

  private async chatCompletions(req: http.IncomingMessage, res: http.ServerResponse, body: any, entry: LogEntry, signal: AbortSignal) {
    const models = await this.deps.getModels();
    const r = this.resolve(body.model, "chat", models, entry);
    const messages = body.messages ?? [];
    const initiator = chatInitiator(messages);
    const vision = chatHasImages(messages);
    entry.initiator = initiator;
    entry.stream = !!body.stream;

    if (supportsEndpoint(r.model, ENDPOINT.chat)) {
      entry.route = "chat (passthrough)";
      try {
        const up = await this.deps.client.request(ENDPOINT.chat, JSON.stringify({ ...body, model: r.id }), { initiator, vision, signal });
        await pipe(up, res, entry);
        return;
      } catch (e) {
        if (!isUnsupportedApi(e) || res.headersSent) throw e;
        entry.route = "chat✗";
      }
    }
    const events = await this.upstreamNorm(body, r, { initiator, vision, signal, exclude: "chat" }, entry);
    if (body.stream) await writeSSE(res, normToChatSSE(events, r.id));
    else sendJSON(res, 200, normToChatJSON(await collect(events), r.id));
    entry.status = 200;
  }

  private async responses(req: http.IncomingMessage, res: http.ServerResponse, body: any, entry: LogEntry, signal: AbortSignal) {
    const models = await this.deps.getModels();
    const r = this.resolve(body.model, "chat", models, entry);
    const initiator = responsesInitiator(body);
    const vision = responsesHasImages(body);
    entry.initiator = initiator;
    entry.stream = !!body.stream;

    if (supportsEndpoint(r.model, ENDPOINT.responses)) {
      entry.route = "responses (passthrough)";
      const fwd = { ...body, model: r.id };
      const removed = stripHostedTools(fwd);
      if (removed.length) debug("stripped hosted tools", removed);
      try {
        const up = await this.deps.client.request(ENDPOINT.responses, JSON.stringify(fwd), { initiator, vision, signal });
        await pipe(up, res, entry);
        return;
      } catch (e) {
        if (!isUnsupportedApi(e) || res.headersSent) throw e;
        entry.route = "responses✗";
      }
    }
    const { chat, customTools } = responsesToChatRequest(body, r.id, r.model);
    entry.route = (entry.route ? entry.route + " " : "") + "responses⇄";
    const events = await this.upstreamNorm(chat, r, { initiator, vision, signal, exclude: "responses" }, entry);
    if (body.stream !== false) await writeSSE(res, normToResponsesSSE(events, r.id, body, customTools));
    else sendJSON(res, 200, normToResponsesJSON(await collect(events), r.id, body, customTools));
    entry.status = 200;
  }

  private async messages(req: http.IncomingMessage, res: http.ServerResponse, body: any, entry: LogEntry, signal: AbortSignal) {
    const models = await this.deps.getModels();
    const r = this.resolve(body.model, "chat", models, entry);
    const initiator = anthropicInitiator(body);
    const vision = anthropicHasImages(body);
    entry.initiator = initiator;
    entry.stream = !!body.stream;

    if (this.deps.settings().preferNativeMessages && supportsEndpoint(r.model, ENDPOINT.messages)) {
      entry.route = "messages (passthrough)";
      const betas = String(req.headers["anthropic-beta"] ?? "")
        .split(",").map((s) => s.trim()).filter((b) => b && ALLOWED_BETAS.some((re) => re.test(b)));
      try {
        const up = await this.deps.client.request(ENDPOINT.messages, JSON.stringify({ ...body, model: r.id }), {
          initiator, vision, signal, extraHeaders: betas.length ? { "anthropic-beta": betas.join(",") } : undefined,
        });
        await pipe(up, res, entry);
        return;
      } catch (e) {
        if (!isUnsupportedApi(e) || res.headersSent) throw e;
        entry.route = "messages✗";
      }
    }
    const chat = anthropicToChatRequest(body, r.id, r.model);
    entry.route = (entry.route ? entry.route + " " : "") + "anthropic⇄";
    const events = await this.upstreamNorm(chat, r, { initiator, vision, signal, exclude: "messages" }, entry);
    if (body.stream) await writeSSE(res, normToAnthropicSSE(events, r.id, estimateAnthropicTokens(body)));
    else sendJSON(res, 200, normToAnthropicJSON(await collect(events), r.id));
    entry.status = 200;
  }

  private async images(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer, entry: LogEntry, endpoint: string, signal: AbortSignal) {
    const models = await this.deps.getModels();
    const ct = String(req.headers["content-type"] ?? "application/json");
    entry.route = endpoint.endsWith("edits") ? "images/edits" : "images/generations";
    entry.initiator = "user";
    let up: Response;
    if (ct.includes("multipart/form-data")) {
      const requested = readMultipartField(raw, "model");
      const r = this.resolve(requested, "image", models, entry);
      const body = setMultipartField(raw, ct, "model", r.id);
      up = await this.deps.client.request(endpoint, body, { contentType: ct, signal });
    } else {
      const body = json(raw);
      const r = this.resolve(body.model, "image", models, entry);
      body.model = r.id;
      delete body.stream;
      up = await this.deps.client.request(endpoint, JSON.stringify(body), { signal });
    }
    await pipe(up, res, entry);
  }

  private async embeddings(res: http.ServerResponse, body: any, entry: LogEntry, signal: AbortSignal) {
    const models = await this.deps.getModels();
    const r = this.resolve(body.model, "embeddings", models, entry);
    entry.route = "embeddings";
    const up = await this.deps.client.request(ENDPOINT.embeddings, JSON.stringify({ ...body, model: r.id }), { signal });
    await pipe(up, res, entry);
  }
}

// ---------------------------------------------------------------------------

function isUnsupportedApi(e: unknown): boolean {
  return e instanceof UpstreamError && (e.status === 400 || e.status === 404) && /unsupported_api|not_supported|not supported|unsupported/i.test(e.body);
}

function extractUpstreamMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    return j?.error?.message ?? j?.message ?? body;
  } catch {
    return body || "Upstream error";
  }
}

function json(raw: Buffer): any {
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "Request body is not valid JSON"); }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, obj: unknown) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

/** 直接把上游响应（含 SSE 流）透传给客户端，同时嗅探 usage 用于统计 */
async function pipe(up: Response, res: http.ServerResponse, entry: LogEntry) {
  const ct = up.headers.get("content-type") ?? "application/json";
  const isStream = ct.includes("event-stream");
  const headers: Record<string, string> = { "content-type": ct };
  if (isStream) { headers["cache-control"] = "no-cache"; headers["x-accel-buffering"] = "no"; }
  res.writeHead(up.status, headers);
  res.flushHeaders?.();
  entry.status = up.status;
  let tail = "";
  let head = "";
  const dec = new TextDecoder();
  if (up.body) {
    const reader = up.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (res.destroyed) { await reader.cancel().catch(() => {}); break; }
        res.write(value);
        const s = dec.decode(value, { stream: true });
        if (head.length < 4096) head += s;
        tail = (tail + s).slice(-16384);
      }
    } finally {
      reader.releaseLock?.();
    }
  }
  res.end();
  sniffUsage(head + tail, entry);
}

function sniffUsage(text: string, entry: LogEntry) {
  const last = (re: RegExp) => { let m: RegExpExecArray | null, v: number | undefined; while ((m = re.exec(text))) v = Number(m[2]); return v; };
  const inp = last(/"(prompt_tokens|input_tokens)"\s*:\s*(\d+)/g);
  const out = last(/"(completion_tokens|output_tokens)"\s*:\s*(\d+)/g);
  const cached = last(/"(cache_read_input_tokens)"\s*:\s*(\d+)/g);
  if (inp !== undefined) entry.inputTokens = inp + (cached ?? 0);
  if (out !== undefined) entry.outputTokens = out;
}

async function* tapUsage(events: AsyncIterable<NormEvent>, entry: LogEntry): AsyncGenerator<NormEvent> {
  for await (const e of events) {
    if (e.t === "done" && e.usage) { entry.inputTokens = e.usage.input; entry.outputTokens = e.usage.output; }
    yield e;
  }
}

async function writeSSE(res: http.ServerResponse, gen: AsyncIterable<string>) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  res.flushHeaders?.();
  for await (const chunk of gen) {
    if (res.destroyed) break;
    res.write(chunk);
  }
  res.end();
}

// ---------------- multipart 辅助（仅替换 model 字段，二进制安全） ----------------

function readMultipartField(raw: Buffer, name: string): string | undefined {
  const s = raw.toString("latin1");
  const re = new RegExp(`Content-Disposition:\\s*form-data;\\s*name="${name}"\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([^\\r]*)\\r\\n`, "i");
  const m = re.exec(s);
  return m ? Buffer.from(m[1], "latin1").toString("utf8") : undefined;
}

function setMultipartField(raw: Buffer, contentType: string, name: string, value: string): Buffer {
  const s = raw.toString("latin1");
  const v = Buffer.from(value, "utf8").toString("latin1");
  const re = new RegExp(`(Content-Disposition:\\s*form-data;\\s*name="${name}"\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n)([^\\r]*)(\\r\\n)`, "i");
  if (re.test(s)) return Buffer.from(s.replace(re, (_m, a, _b, c) => a + v + c), "latin1");
  const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (!boundary) return raw;
  const part = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${v}\r\n`;
  return Buffer.concat([Buffer.from(part, "latin1"), raw]);
}
