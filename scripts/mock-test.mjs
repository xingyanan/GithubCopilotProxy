// 端到端自测：启动一个模拟的 Copilot 上游，验证各协议的直通 / 翻译 / 生图 / 一键配置
// 用法: npm test   （会先 build，再运行本脚本；不会访问真实 GitHub）
import { createRequire } from "node:module";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// 隔离 HOME，避免改动真实的 ~/.claude 与 ~/.codex
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cpx-test-"));
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, ".claude");
process.env.CODEX_HOME = path.join(tmpHome, ".codex");

const { AppCore } = require(path.join(root, "dist/core/app.js"));

// ---------------------------------------------------------------- mock upstream
const calls = [];
let devicePolls = 0;
const MODELS = {
  data: [
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", vendor: "Anthropic", model_picker_enabled: true, capabilities: { type: "chat", limits: { max_output_tokens: 16000, max_context_window_tokens: 200000 }, supports: { tool_calls: true, vision: true, streaming: true } }, supported_endpoints: ["/chat/completions", "/v1/messages"], billing: { multiplier: 1 } },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", vendor: "Anthropic", model_picker_enabled: true, capabilities: { type: "chat", limits: { max_output_tokens: 32000 }, supports: { tool_calls: true } }, supported_endpoints: ["/v1/messages"] },
    { id: "gpt-5-codex", name: "GPT-5 Codex", vendor: "OpenAI", model_picker_enabled: true, capabilities: { type: "chat", limits: { max_output_tokens: 128000 }, supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] } }, supported_endpoints: ["/responses"] },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", vendor: "Google", model_picker_enabled: true, capabilities: { type: "chat", limits: {}, supports: { tool_calls: true } } },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", vendor: "Anthropic", model_picker_enabled: true, capabilities: { type: "chat", limits: {}, supports: { tool_calls: true } }, supported_endpoints: ["/chat/completions", "/v1/messages"] },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", vendor: "Anthropic", model_picker_enabled: true, capabilities: { type: "chat", limits: {}, supports: { tool_calls: true } }, supported_endpoints: ["/chat/completions"] },
    { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", vendor: "OpenAI", model_picker_enabled: false, capabilities: { type: "image" }, supported_endpoints: ["/v1/images/generations", "/v1/images/edits"] },
    { id: "text-embedding-3-small", name: "Embedding", vendor: "OpenAI", capabilities: { type: "embeddings" } },
  ],
};

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(e);
  res.end();
};
const d = (o) => `data: ${JSON.stringify(o)}\n\n`;
const ev = (t, o) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...o })}\n\n`;

const upstream = http.createServer(async (req, res) => {
  let body = Buffer.alloc(0);
  for await (const c of req) body = Buffer.concat([body, c]);
  const ct = req.headers["content-type"] ?? "";
  const j = ct.includes("json") && body.length ? JSON.parse(body.toString()) : null;
  calls.push({ path: req.url, headers: req.headers, body: j, raw: body });
  const url = req.url;
  if (url === "/copilot_internal/v2/token") {
    res.end(JSON.stringify({ token: "cop-token", expires_at: Math.floor(Date.now() / 1000) + 1800, refresh_in: 1500, endpoints: { api: `http://127.0.0.1:${upstream.address().port}` } }));
  } else if (url === "/login/device/code") res.end(JSON.stringify({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 0 }));
  else if (url === "/login/oauth/access_token") {
    devicePolls++;
    res.end(JSON.stringify(devicePolls < 2 ? { error: "authorization_pending" } : { access_token: "gho_device", token_type: "bearer" }));
  } else if (url === "/user") res.end(JSON.stringify({ login: "octocat", name: "Octo", avatar_url: `http://127.0.0.1:${upstream.address().port}/avatar.png?v=4` }));
  else if (url.startsWith("/avatar.png")) { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from("AVATAR")); }
  else if (url === "/copilot_internal/user") res.end(JSON.stringify({ copilot_plan: "individual", quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 250, unlimited: false } } }));
  else if (url === "/models") res.end(JSON.stringify(MODELS));
  else if (url === "/chat/completions") {
    if (!["claude-sonnet-4.5", "claude-sonnet-4", "gemini-2.5-pro", "claude-haiku-4.5"].includes(j.model)) { res.writeHead(400); res.end(JSON.stringify({ error: { message: "unsupported_api_for_model" } })); return; }
    if (!j.stream) { res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })); return; }
    if (j.messages?.[0]?.content === "SLOW") {
      // 模拟慢速流：首包后 1 秒才结束，用于验证并发不阻塞
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(d({ choices: [{ index: 0, delta: { role: "assistant", content: "slow" } }] }));
      await new Promise((r) => setTimeout(r, 1000));
      res.end(d({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
      return;
    }
    const evs = [d({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }), d({ choices: [{ index: 0, delta: { content: "lo" } }] })];
    if (j.tools?.length) {
      // Copilot 特性：工具调用出现在另一个 choice 中
      evs.push(d({ choices: [{ index: 1, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: j.tools[0].function.name, arguments: "" } }] } }] }));
      const args = j.tools[0].function.name === "apply_patch" ? JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }) : '{"path":"a.txt"}';
      evs.push(d({ choices: [{ index: 1, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] } }] }));
      evs.push(d({ choices: [{ index: 1, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }, finish_reason: "tool_calls" }] }));
    } else evs.push(d({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    evs.push(d({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } }), "data: [DONE]\n\n");
    sse(res, evs);
  } else if (url === "/responses") {
    if (j.model !== "gpt-5-codex") { res.writeHead(400); res.end('{"error":{"message":"unsupported_api_for_model"}}'); return; }
    const evs = [
      ev("response.created", { response: { id: "r1" } }),
      ev("response.output_item.added", { output_index: 0, item: { type: "message", id: "m1" } }),
      ev("response.output_text.delta", { item_id: "m1", output_index: 0, delta: "Hi from codex" }),
    ];
    if (j.tools?.length) {
      evs.push(ev("response.output_item.added", { output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_r1", name: j.tools[0].name, arguments: "" } }));
      evs.push(ev("response.function_call_arguments.delta", { item_id: "fc1", output_index: 1, delta: '{"x":1}' }));
      evs.push(ev("response.output_item.done", { output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_r1", name: j.tools[0].name, arguments: '{"x":1}' } }));
    }
    evs.push(ev("response.completed", { response: { id: "r1", status: "completed", usage: { input_tokens: 11, output_tokens: 3 } } }));
    sse(res, evs);
  } else if (url === "/v1/messages") {
    if (!["claude-sonnet-4.5", "claude-opus-5.5"].includes(j.model)) { res.writeHead(400); res.end('{"error":{"message":"model_not_supported"}}'); return; }
    const evs = [
      ev("message_start", { message: { id: "msg1", usage: { input_tokens: 9, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "native " + j.model } }),
      ev("content_block_stop", { index: 0 }),
    ];
    if (j.tools?.length) {
      evs.push(ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: j.tools[0].name, input: {} } }));
      evs.push(ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"input":"*** Begin' } }));
      evs.push(ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: ' Patch"}' } }));
      evs.push(ev("content_block_stop", { index: 1 }));
    }
    evs.push(ev("message_delta", { delta: { stop_reason: j.tools?.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 4 } }), ev("message_stop", {}));
    sse(res, evs);
  } else if (url === "/v1/images/generations" || url === "/v1/images/edits") {
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from("PNGDATA").toString("base64") }], usage: { input_tokens: 10, output_tokens: 100 } }));
  } else if (url === "/embeddings") {
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }], model: j.model }));
  } else { res.writeHead(404); res.end("nf " + url); }
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UP = `http://127.0.0.1:${upstream.address().port}`;

const mockFetch = () => (url, init) => fetch(url.replace("https://api.github.com", UP).replace("https://github.com", UP), init);

// ---------------------------------------------------------------- core
const core = new AppCore({ dataDir: path.join(tmpHome, "data"), version: "test", fetch: mockFetch });
core.store.setAuth("gho_test", { login: "octocat" });
await core.updateSettings({ port: 0 + 41999, autoStartProxy: false });
await core.startProxy();
await core.refreshModels();
const BASE = core.baseUrl();
let pass = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log("✔", name); }
  catch (e) { console.error("✗", name, "\n ", e); process.exitCode = 1; }
};
const post = (p, body, headers = {}) => fetch(core.baseUrl() + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const parseSSE = (text) => text.split("\n\n").filter(Boolean).map((blk) => {
  const evm = /^event: (.*)$/m.exec(blk); const dm = /^data: (.*)$/m.exec(blk);
  return { event: evm?.[1], data: dm?.[1] === "[DONE]" ? "[DONE]" : dm ? JSON.parse(dm[1]) : null };
});
const lastCall = () => calls[calls.length - 1];

await test("GET /v1/models 列出全部模型（含生图）", async () => {
  const j = await (await fetch(BASE + "/v1/models")).json();
  assert.equal(j.data.length, 8);
  assert.ok(j.data.find((m) => m.id === "gpt-image-2.5-sunburst" && m.type === "image"));
});

await test("默认值自动填充", async () => {
  const s = core.settings;
  assert.equal(s.claude.model, "claude-sonnet-4.5");
  assert.equal(s.claude.smallModel, "claude-haiku-4.5");
  assert.equal(s.codex.model, "gpt-5-codex");
  assert.equal(s.imageModel, "gpt-image-2.5-sunburst");
});

await test("Claude Code: /v1/messages 原生直通 + 模型名归一化", async () => {
  const r = await post("/v1/messages", { model: "claude-sonnet-4-5-20250929", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] }, { "anthropic-beta": "interleaved-thinking-2025-05-14,claude-code-20250219" });
  const t = await r.text();
  assert.match(t, /native claude-sonnet-4.5/);
  assert.equal(lastCall().path, "/v1/messages");
  assert.equal(lastCall().body.model, "claude-sonnet-4.5");
  assert.equal(lastCall().headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
  assert.equal(lastCall().headers["x-initiator"], "user");
});

await test("Claude Code: /v1/messages → Gemini（chat 翻译，工具调用跨 choice）", async () => {
  const r = await post("/v1/messages", {
    model: "gemini-2.5-pro", max_tokens: 100, stream: true, system: [{ type: "text", text: "sys" }],
    tools: [{ name: "read_file", description: "r", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    messages: [
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "read_file", input: { path: "b" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "ok" }] },
    ],
  });
  const evs = parseSSE(await r.text());
  const up = lastCall();
  assert.equal(up.path, "/chat/completions");
  assert.equal(up.headers["x-initiator"], "agent");
  assert.deepEqual(up.body.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  const start = evs.find((e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use");
  assert.equal(start.data.content_block.name, "read_file");
  const json = evs.filter((e) => e.data?.delta?.type === "input_json_delta").map((e) => e.data.delta.partial_json).join("");
  assert.equal(json, '{"path":"a.txt"}');
  const md = evs.find((e) => e.event === "message_delta");
  assert.equal(md.data.delta.stop_reason, "tool_use");
  assert.equal(md.data.usage.output_tokens, 7);
  assert.equal(evs[evs.length - 1].event, "message_stop");
});

await test("Claude Code: /v1/messages → gpt-5-codex（anthropic→chat→responses 链式翻译，非流式）", async () => {
  const r = await post("/v1/messages", { model: "gpt-5-codex", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
  const j = await r.json();
  assert.equal(lastCall().path, "/responses");
  assert.equal(j.type, "message");
  assert.equal(j.content[0].text, "Hi from codex");
  assert.equal(j.usage.input_tokens, 11);
});

await test("Claude Code: haiku 后台请求回退到 smallModel", async () => {
  await post("/v1/messages", { model: "claude-3-5-haiku-20241022", max_tokens: 10, messages: [{ role: "user", content: "t" }] }).then((r) => r.text());
  assert.equal(lastCall().body.model, "claude-haiku-4.5");
});

await test("原生 /v1/messages 被上游拒绝时自动回退到 chat 翻译", async () => {
  const t = await (await post("/v1/messages", { model: "claude-sonnet-4", max_tokens: 10, stream: true, messages: [{ role: "user", content: "t" }] })).text();
  assert.equal(calls[calls.length - 2].path, "/v1/messages");
  assert.equal(lastCall().path, "/chat/completions");
  assert.match(t, /"text":"Hel"/);
  assert.match(t, /message_stop/);
});

await test("count_tokens 估算", async () => {
  const j = await (await post("/v1/messages/count_tokens", { model: "x", messages: [{ role: "user", content: "hello world" }] })).json();
  assert.ok(j.input_tokens > 0);
});

await test("Codex: /v1/responses → gpt-5-codex 直通（剥离托管工具）", async () => {
  const r = await post("/v1/responses", { model: "gpt-5-codex", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], tools: [{ type: "web_search" }, { type: "function", name: "shell", parameters: { type: "object" } }] });
  const t = await r.text();
  assert.match(t, /Hi from codex/);
  assert.deepEqual(lastCall().body.tools.map((x) => x.type), ["function"]);
});

await test("Codex: /v1/responses → Claude（responses→chat 翻译 + custom 工具 apply_patch）", async () => {
  const r = await post("/v1/responses", {
    model: "claude-sonnet-4.5", stream: true, instructions: "be helpful",
    tools: [{ type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "fix" }] },
      { type: "custom_tool_call", call_id: "c0", name: "apply_patch", input: "old" },
      { type: "custom_tool_call_output", call_id: "c0", output: "done" },
      { type: "reasoning", summary: [] },
    ],
  });
  const evs = parseSSE(await r.text());
  const up = lastCall();
  assert.equal(up.path, "/chat/completions");
  assert.equal(up.body.tools[0].function.name, "apply_patch");
  assert.equal(up.body.messages[2].tool_calls[0].function.arguments, JSON.stringify({ input: "old" }));
  const done = evs.filter((e) => e.event === "response.output_item.done").map((e) => e.data.item);
  assert.equal(done[0].type, "message");
  assert.equal(done[0].content[0].text, "Hello");
  assert.equal(done[1].type, "custom_tool_call");
  assert.equal(done[1].input, "*** Begin Patch\n*** End Patch");
  const completed = evs.find((e) => e.event === "response.completed");
  assert.equal(completed.data.response.usage.input_tokens, 42);
  assert.ok(evs.every((e, i) => e.data.sequence_number === i));
});

await test("Codex: /v1/responses → claude-opus-5.5（仅 /v1/messages：responses→chat→anthropic）", async () => {
  const r = await post("/v1/responses", { model: "claude-opus-5.5", stream: true, input: "hello", tools: [{ type: "custom", name: "apply_patch" }] });
  const evs = parseSSE(await r.text());
  assert.equal(lastCall().path, "/v1/messages");
  assert.equal(lastCall().body.max_tokens, 32000);
  const items = evs.filter((e) => e.event === "response.output_item.done").map((e) => e.data.item);
  assert.equal(items[0].content[0].text, "native claude-opus-5.5");
  assert.equal(items[1].type, "custom_tool_call");
  assert.equal(items[1].input, "*** Begin Patch");
});

await test("OpenAI: /v1/chat/completions → gpt-5-codex 非流式（chat→responses）", async () => {
  const j = await (await post("/v1/chat/completions", { model: "gpt-5-codex", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }] })).json();
  assert.equal(lastCall().body.instructions, "s");
  assert.equal(j.choices[0].message.content, "Hi from codex");
  assert.equal(j.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(j.choices[0].finish_reason, "tool_calls");
});

await test("OpenAI: /v1/chat/completions 直通（流式）", async () => {
  const t = await (await post("/v1/chat/completions", { model: "gemini-2.5-pro", stream: true, messages: [{ role: "user", content: "hi" }] })).text();
  assert.match(t, /\[DONE\]/);
  assert.equal(lastCall().body.model, "gemini-2.5-pro");
});

await test("生图: gpt-image-2 别名自动映射到 Copilot 生图模型", async () => {
  const j = await (await post("/v1/images/generations", { model: "gpt-image-2", prompt: "a cat", size: "1024x1024", stream: true })).json();
  assert.equal(lastCall().path, "/v1/images/generations");
  assert.equal(lastCall().body.model, "gpt-image-2.5-sunburst");
  assert.equal(lastCall().body.stream, undefined);
  assert.equal(Buffer.from(j.data[0].b64_json, "base64").toString(), "PNGDATA");
});

await test("生图: multipart 编辑请求替换 model 字段", async () => {
  const fd = new FormData();
  fd.append("model", "gpt-image-1");
  fd.append("prompt", "make it blue");
  fd.append("image", new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])], { type: "image/png" }), "a.png");
  const r = await fetch(BASE + "/v1/images/edits", { method: "POST", body: fd });
  assert.equal(r.status, 200);
  const raw = lastCall().raw.toString("latin1");
  assert.match(raw, /name="model"\r\n\r\ngpt-image-2.5-sunburst\r\n/);
  assert.ok(raw.includes("\x89PNG\x00\x01\x02\xff"));
});

await test("生图: AppCore.generateImage 保存文件", async () => {
  const out = path.join(tmpHome, "imgs");
  const r = await core.generateImage({ prompt: "dog" }, out);
  assert.equal(r.model, "gpt-image-2.5-sunburst");
  assert.equal(fs.readFileSync(r.savedPaths[0], "utf8"), "PNGDATA");
});

await test("Embeddings 直通", async () => {
  const j = await (await post("/v1/embeddings", { model: "text-embedding-3-small", input: "x" })).json();
  assert.equal(j.data[0].embedding.length, 2);
});

await test("一键配置 Claude Code：保留原有配置并可精确还原", async () => {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { FOO: "1", ANTHROPIC_MODEL: "old" } }));
  core.applyClaude();
  core.applyClaude(); // 重复应用不应覆盖原始备份
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(j.env.ANTHROPIC_BASE_URL, BASE);
  assert.equal(j.env.ANTHROPIC_MODEL, "claude-sonnet-4.5");
  assert.equal(j.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4.5");
  assert.equal(j.env.FOO, "1");
  assert.deepEqual(j.permissions, { allow: ["Bash(ls)"] });
  assert.ok(core.state().integrations.claude.applied);
  assert.ok(fs.existsSync(file + ".copilot-proxy.bak"));
  core.restoreClaude();
  const k = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(k.env, { FOO: "1", ANTHROPIC_MODEL: "old" });
  assert.equal(core.state().integrations.claude.applied, false);
});

await test("一键配置 Codex：TOML 顶层键 + provider 表，可精确还原", async () => {
  const file = path.join(process.env.CODEX_HOME, "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = `# my config\nmodel = "o3"  # comment\napproval_policy = "on-request"\n\n[mcp_servers.fs]\ncommand = "npx"\n\n[model_providers.copilot-proxy]\nname = "stale"\n`;
  fs.writeFileSync(file, 'model_catalog_json = "original-models.json"\n' + original);
  await core.updateSettings({ codex: { reasoningEffort: "high" } });
  core.applyCodex();
  const t = fs.readFileSync(file, "utf8");
  const top = t.split("[mcp_servers.fs]")[0];
  assert.match(top, /^model = "gpt-5-codex"$/m);
  assert.match(top, /^model_provider = "copilot-proxy"$/m);
  assert.match(top, /^model_reasoning_effort = "high"$/m);
  assert.match(top, /^model_max_output_tokens = 128000$/m);
  const catalogFile = path.join(process.env.CODEX_HOME, "copilot-proxy-models.json");
  assert.equal(JSON.parse(/^model_catalog_json = (.+)$/m.exec(top)[1]), catalogFile);
  const catalog = () => JSON.parse(fs.readFileSync(catalogFile, "utf8")).models;
  assert.equal(catalog().length, 1);
  assert.equal(catalog()[0].slug, "gpt-5-codex");
  assert.equal(catalog()[0].visibility, "list");
  assert.match(t, /\[model_providers\.copilot-proxy\]\nname = "GitHub Copilot \(local proxy\)"\nbase_url = "http:\/\/127\.0\.0\.1:41999\/v1"\nwire_api = "responses"/);
  assert.equal((t.match(/\[model_providers\.copilot-proxy\]/g) ?? []).length, 1);
  assert.ok(!t.includes('"stale"'));
  assert.match(t, /\[mcp_servers\.fs\]\ncommand = "npx"/);
  assert.ok(core.state().integrations.codex.applied);
  await core.updateSettings({ codex: { model: "gemini-2.5-pro" } });
  core.applyCodex();
  assert.deepEqual(catalog().map((model) => model.slug), ["gemini-2.5-pro"]);
  core.restoreCodex();
  const r = fs.readFileSync(file, "utf8");
  assert.match(r, /^model = "o3"$/m);
  assert.match(r, /^model_catalog_json = "original-models.json"$/m);
  assert.ok(!/model_provider/.test(r));
  assert.ok(!/model_reasoning_effort/.test(r));
  assert.match(r, /approval_policy = "on-request"/);
  assert.match(r, /\[mcp_servers\.fs\]/);
});

await test("本地 API Key 校验", async () => {
  await core.updateSettings({ apiKey: "sk-local" });
  const r1 = await post("/v1/chat/completions", { model: "gemini-2.5-pro", messages: [{ role: "user", content: "x" }] });
  assert.equal(r1.status, 401);
  const r2 = await post("/v1/chat/completions", { model: "gemini-2.5-pro", messages: [{ role: "user", content: "x" }] }, { "x-api-key": "sk-local" });
  assert.equal(r2.status, 200);
  await core.updateSettings({ apiKey: "" });
});

await test("GitHub Device Code 登录流程", async () => {
  core.logout();
  assert.equal(core.state().loggedIn, false);
  const st = await core.startLogin();
  assert.equal(st.status, "pending");
  assert.equal(st.info.userCode, "ABCD-1234");
  for (let i = 0; i < 100 && core.state().login.status === "pending"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(core.state().login.status, "success");
  assert.equal(core.store.getGithubToken(), "gho_device");
  assert.ok(devicePolls >= 2);
  for (let i = 0; i < 50 && core.state().models.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(core.state().models.length > 0);
});

await test("头像在主进程下载为 data URL", async () => {
  await core.refreshAccount();
  const u = core.state().user;
  assert.equal(u.avatarDataUrl, "data:image/png;base64," + Buffer.from("AVATAR").toString("base64"));
});

await test("端口被占用时拒绝修改，原服务保持运行", async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const busy = blocker.address().port;
  await assert.rejects(core.updateSettings({ port: busy }), /占用|in use/);
  assert.equal(core.settings.port, 41999);
  assert.equal(core.state().proxy.running, true);
  // 停止服务后用被占用端口直接启动：失败并给出错误，状态为未运行
  await core.stopProxy();
  core.store.updateSettings({ port: busy });
  await assert.rejects(core.startProxy(), /占用|in use/);
  assert.equal(core.state().proxy.running, false);
  assert.match(core.state().proxy.error, /占用|in use/);
  // 改到可用端口：自动重新启动并清除错误
  core.store.updateSettings({ port: 41999 });
  await core.updateSettings({ port: 41998 });
  assert.equal(core.state().proxy.running, true);
  assert.equal(core.state().proxy.error, undefined);
  assert.equal(core.state().proxy.url, "http://127.0.0.1:41998");
  blocker.close();
});

await test("多客户端并发：20 个慢速流式请求并行完成，不互相阻塞", async () => {
  const t0 = Date.now();
  const one = (i) => i % 2
    ? post("/v1/messages", { model: "gemini-2.5-pro", max_tokens: 10, stream: true, messages: [{ role: "user", content: "SLOW" }] }).then((r) => r.text())
    : post("/v1/chat/completions", { model: "gemini-2.5-pro", stream: true, messages: [{ role: "user", content: "SLOW" }] }).then((r) => r.text());
  const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => one(i)));
  const ms = Date.now() - t0;
  assert.ok(outs.every((t) => t.includes("slow")));
  assert.ok(ms < 2500, `耗时 ${ms}ms，疑似串行`);
});

await test("中英文切换：错误提示随语言变化", async () => {
  await core.updateSettings({ language: "zh" });
  assert.equal(core.state().lang, "zh");
  {
    const busy = http.createServer();
    await new Promise((r) => busy.listen(0, "127.0.0.1", r));
    await assert.rejects(core.updateSettings({ port: busy.address().port }), /已被其他程序占用/);
    busy.close();
  }
  await core.updateSettings({ language: "en" });
  assert.equal(core.state().lang, "en");
  await core.stopProxy();
  const busy = http.createServer();
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  await assert.rejects(core.updateSettings({ port: busy.address().port }), /already in use/);
  busy.close();
  await core.updateSettings({ language: "auto" });
  await core.startProxy();
});

await test("请求日志与统计", async () => {
  const st = core.state();
  assert.ok(st.stats.requests >= 10);
  assert.ok(st.stats.inputTokens > 0);
  assert.equal(st.user.login, "octocat");
});

console.log(`\n${pass} passed${process.exitCode ? ", 有失败用例" : ""}`);
await core.dispose();
upstream.close();
fs.rmSync(tmpHome, { recursive: true, force: true });
