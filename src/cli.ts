#!/usr/bin/env node
/**
 * 无界面命令行入口（与桌面端共享 ~/.copilot-proxy 配置）
 *   copilot-proxy login | logout | serve | models | status
 *   copilot-proxy apply-claude [--model x --small y] | restore-claude
 *   copilot-proxy apply-codex  [--model x] | restore-codex
 *   copilot-proxy image "a cat" [--model m --size 1024x1024 --out ./images]
 */
import * as os from "node:os";
import * as path from "node:path";
import { AppCore } from "./core/app";

const pkgVersion = (() => { try { return require("../package.json").version; } catch { return "dev"; } })();

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] ?? "serve";
  const dataDir = String(flags["data-dir"] ?? process.env.COPILOT_PROXY_HOME ?? path.join(os.homedir(), ".copilot-proxy"));
  const core = new AppCore({ dataDir, version: pkgVersion });
  if (flags.port) await core.updateSettings({ port: Number(flags.port) });
  if (flags.host) await core.updateSettings({ host: String(flags.host) });

  switch (cmd) {
    case "login": {
      const st = await core.startLogin();
      if (st.status !== "pending") throw new Error("无法开始登录");
      console.log(`\n请在浏览器打开: ${st.info.verificationUri}\n输入验证码:     ${st.info.userCode}\n\n等待授权中...`);
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          const s = core.state().login;
          if (s.status === "success") resolve();
          else if (s.status === "error") reject(new Error(s.message));
          else setTimeout(check, 500);
        };
        check();
      });
      const s = core.state();
      console.log(`✔ 登录成功: ${s.user?.login ?? ""}，可用模型 ${s.models.length} 个`);
      await core.dispose();
      process.exit(0);
    }
    case "logout":
      core.logout();
      console.log("已退出登录");
      return;
    case "models": {
      const models = await core.refreshModels();
      const rows = models.map((m) => ({
        id: m.id, kind: m.kind, vendor: m.vendor, endpoints: m.endpoints.join(","),
        x: m.multiplier ?? "", picker: m.pickerEnabled ? "" : "hidden", policy: m.policyState ?? "",
      }));
      console.table(rows);
      return;
    }
    case "status": {
      const s = core.state();
      console.log(JSON.stringify({ loggedIn: s.loggedIn, user: s.user?.login, proxy: s.proxy, integrations: s.integrations, settings: { ...s.settings, apiKey: s.settings.apiKey ? "***" : "" } }, null, 2));
      return;
    }
    case "apply-claude": {
      if (flags.model || flags.small || flags.opus) {
        await core.updateSettings({ claude: { ...(flags.model ? { model: String(flags.model) } : {}), ...(flags.small ? { smallModel: String(flags.small) } : {}), ...(flags.opus ? { opusModel: String(flags.opus) } : {}) } });
      } else if (!core.settings.claude.model) await core.refreshModels();
      console.log("已写入:", core.applyClaude());
      return;
    }
    case "restore-claude":
      console.log("已还原:", core.restoreClaude());
      return;
    case "apply-codex": {
      if (flags.model) await core.updateSettings({ codex: { model: String(flags.model) } });
      if (flags.effort) await core.updateSettings({ codex: { reasoningEffort: String(flags.effort) } });
      await core.refreshModels().catch(() => {});
      console.log("已写入:", core.applyCodex());
      return;
    }
    case "restore-codex":
      console.log("已还原:", core.restoreCodex());
      return;
    case "image": {
      const prompt = pos.slice(1).join(" ");
      if (!prompt) throw new Error('用法: copilot-proxy image "提示词" [--model m] [--size 1024x1024] [--out dir]');
      const out = String(flags.out ?? path.join(process.cwd(), "copilot-images"));
      const r = await core.generateImage({ prompt, model: flags.model as string, size: flags.size as string, quality: flags.quality as string }, out);
      console.log(`✔ ${r.model} 用时 ${(r.durationMs / 1000).toFixed(1)}s`);
      for (const p of r.savedPaths ?? []) console.log("  ", p);
      return;
    }
    case "serve": {
      if (!core.loggedIn) console.warn("⚠ 尚未登录，请先运行: copilot-proxy login");
      await core.init();
      if (!core.server.running) await core.startProxy();
      const base = core.baseUrl();
      console.log(`Copilot Proxy ${pkgVersion} 正在运行: ${base}`);
      console.log(`  OpenAI:    ${base}/v1/chat/completions | ${base}/v1/responses`);
      console.log(`  Anthropic: ${base}/v1/messages`);
      console.log(`  Images:    ${base}/v1/images/generations | ${base}/v1/images/edits`);
      core.log.on("entry", (e) => {
        const tok = e.inputTokens !== undefined ? ` in=${e.inputTokens} out=${e.outputTokens ?? 0}` : "";
        console.log(`${new Date(e.time).toLocaleTimeString()} ${e.status} ${e.method} ${e.path} ${e.requestedModel ?? ""}${e.model && e.model !== e.requestedModel ? " → " + e.model : ""} [${e.route ?? ""}] ${e.durationMs}ms${tok}${e.error ? " ✗ " + e.error : ""}`);
      });
      const shutdown = async () => { await core.dispose(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    default:
      console.log("命令: login | logout | serve | models | status | apply-claude | restore-claude | apply-codex | restore-codex | image");
  }
}

main().catch((e) => {
  console.error("✗", e?.message ?? e);
  process.exit(1);
});
