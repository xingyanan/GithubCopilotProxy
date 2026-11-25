<p align="center">
  <img src="assets/icon.png" width="96" alt="Copilot Proxy">
</p>

<h1 align="center">Copilot Proxy</h1>

<p align="center">
  登录 <b>GitHub Copilot</b>，在本机提供 OpenAI / Anthropic 兼容接口的桌面客户端，<br>
  让 <b>Claude Code</b>、<b>Codex</b> 等工具直接使用你 Copilot 订阅里的模型。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <a href="https://github.com/xingyanan/GithubCopilotProxy/releases"><img src="https://img.shields.io/github/v/release/xingyanan/GithubCopilotProxy" alt="release"></a>
  <a href="https://github.com/xingyanan/GithubCopilotProxy/actions/workflows/ci.yml"><img src="https://github.com/xingyanan/GithubCopilotProxy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

## 功能

- **GitHub 设备码登录**：应用显示验证码，点一下复制并打开 github.com/login/device。GitHub token 用系统钥匙串加密保存（Windows DPAPI / macOS 钥匙串 / libsecret）。
- **账号下的全部模型**：列出你能用的所有模型，包括 Copilot 模型选择器里隐藏的生图模型。
- **一键配置 Claude Code 和 Codex**：选好模型点“配置”即可。写入前会备份原配置，“还原”只恢复被改动的项目。
- **自动协议转换**：Copilot 上每个模型只支持部分上游接口。代理会读取模型声明的 `supported_endpoints`，在 Anthropic Messages、OpenAI Responses 和 Chat Completions 之间自动转换，所以 Claude Code 可以用 GPT 模型，Codex 也可以用 Claude、Gemini。
- **OpenAI 格式生图接口**：`/v1/images/generations` 与 `/v1/images/edits`（JSON 和 multipart 都支持）。请求 `gpt-image-1` 等名称时自动映射到账号里可用的生图模型。
- **托盘常驻**：关闭窗口后服务在系统托盘继续运行，支持开机启动。
- **中英文界面**：点标题栏的按钮或在设置中切换。

## 接口

服务地址：`http://127.0.0.1:4141`（端口可在设置中修改）。未设置访问密钥时，API Key 填任意值即可。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/models` | 模型列表（OpenAI 格式；带 `anthropic-version` 请求头时返回 Anthropic 格式） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions 客户端 |
| POST | `/v1/responses` | Codex 等 OpenAI Responses 客户端 |
| POST | `/v1/messages` | Claude Code 等 Anthropic 客户端 |
| POST | `/v1/messages/count_tokens` | Claude Code（估算值） |
| POST | `/v1/images/generations` | OpenAI 格式生图 |
| POST | `/v1/images/edits` | OpenAI 格式改图 |
| POST | `/v1/embeddings` | 向量 |

示例：

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"你好"}]}'

curl http://127.0.0.1:4141/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"一只戴飞行员护目镜的柴犬","size":"1024x1024"}'
```

## 下载

在 [Releases](https://github.com/xingyanan/GithubCopilotProxy/releases) 下载最新版本：

| 平台 | 文件 |
| --- | --- |
| Windows | `CopilotProxy-Setup-x.y.z.exe`（安装版）或 `CopilotProxy-x.y.z-portable.exe`（免安装） |
| macOS | `CopilotProxy-x.y.z-arm64.dmg` / `CopilotProxy-x.y.z-x64.dmg` |
| Linux | `CopilotProxy-x.y.z-x86_64.AppImage` |

安装包没有代码签名。Windows 上 SmartScreen 可能拦截，点“更多信息 → 仍要运行”；macOS 首次打开请右键应用选择“打开”。

## 使用

1. 打开应用，点“登录 GitHub”，在打开的 GitHub 页面输入验证码。
2. 确认 API 服务开关已打开。
3. 在“一键配置”里为 Claude Code 或 Codex 选择模型并点“配置”，然后重启对应工具。

写入的内容：

- **Claude Code**：`~/.claude/settings.json` 的 `env` 字段（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 以及 sonnet / opus / haiku 别名）。支持 `CLAUDE_CONFIG_DIR`。
- **Codex**：`~/.codex/config.toml` 中的 `model`、`model_provider` 和 `[model_providers.copilot-proxy]`（`wire_api = "responses"`）。支持 `CODEX_HOME`。

首次写入时原文件会复制为 `*.copilot-proxy.bak`。之后修改端口或访问密钥，已配置的工具会自动同步。

## 从源码构建

需要 Node.js 18 或更高版本。

```bash
npm install
npm start            # 运行桌面端
npm test             # 基于模拟 Copilot 上游的端到端测试
npm run dist:exe     # Windows 免安装 exe     → release/
npm run dist:dir     # Windows 解压版目录     → release/win-unpacked/
npm run dist:win     # Windows 安装版 + 免安装版
npm run dist:mac     # macOS dmg
npm run dist:linux   # Linux AppImage
```

Windows 下也可以直接双击 `build-exe.cmd`。

npm 或 Electron 下载慢时可以使用镜像：

```bash
npm install --registry=https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

### 命令行

命令行与桌面端共用配置目录 `~/.copilot-proxy`。

```bash
npm run build
node dist/cli.js login            # 设备码登录
node dist/cli.js serve --port 4141
node dist/cli.js models
node dist/cli.js apply-claude --model claude-sonnet-4.5 --small gpt-4.1
node dist/cli.js apply-codex --model gpt-5-codex --effort high
node dist/cli.js restore-claude
node dist/cli.js restore-codex
```

## 发布

推送以 `v` 开头的标签会触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)：先跑测试，再分别构建 Windows、macOS、Linux 安装包，最后创建 GitHub Release，附带所有文件和 `SHA256SUMS.txt`。应用版本号取自标签。

```bash
git tag v1.0.0
git push origin v1.0.0
```

带连字符的标签（如 `v1.1.0-beta.1`）会发布为预发布版本。

## 目录结构

```
src/core/          代理核心，与 Electron 无关（命令行也使用）
  auth.ts          设备码登录与 Copilot token 刷新
  copilot.ts       Copilot API 客户端
  models.ts        模型列表解析与名称匹配
  server.ts        HTTP 服务与路由
  translate/       Anthropic / Responses / Chat 协议转换
  integrations.ts  Claude Code 与 Codex 配置写入
src/main/          Electron 主进程、托盘、preload
src/renderer/      界面
scripts/           图标生成与测试
```

## 说明

- 本项目使用与官方 Copilot 编辑器插件相同的 OAuth 客户端和接口，与 GitHub、OpenAI、Anthropic 均无关联，也未获其认可。请确保你的使用方式符合 GitHub Copilot 的服务条款；上游接口随时可能变化。
- 默认只监听 `127.0.0.1`。开启局域网访问时必须设置访问密钥。
- Copilot 生图目前为公开预览，需要 Copilot Pro / Pro+ / Business / Enterprise；组织账号可能需要管理员在 Copilot 策略中开启生图模型。
- 凭据与设置保存在 `~/.copilot-proxy/config.json`，除 GitHub 与 Copilot API 外不会发送到任何地方。

## 许可证

[MIT](LICENSE)
