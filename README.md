<p align="center">
  <img src="assets/icon.png" width="96" alt="Copilot Proxy">
</p>

<h1 align="center">Copilot Proxy</h1>

<p align="center">
  A desktop app that signs in to <b>GitHub Copilot</b> and serves OpenAI / Anthropic compatible APIs on your machine,<br>
  so <b>Claude Code</b>, <b>Codex</b> and other tools can use the models in your Copilot subscription.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/xingyanan/GithubCopilotProxy/releases"><img src="https://img.shields.io/github/v/release/xingyanan/GithubCopilotProxy" alt="release"></a>
  <a href="https://github.com/xingyanan/GithubCopilotProxy/actions/workflows/ci.yml"><img src="https://github.com/xingyanan/GithubCopilotProxy/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

## Features

- **GitHub device-code sign-in.** The app shows a code; one click copies it and opens github.com/login/device. Your GitHub token is encrypted with the OS keychain (Windows DPAPI, macOS Keychain, libsecret).
- **All your Copilot models.** Lists every model your account can use, including image models that are hidden from the Copilot model picker.
- **One-click setup for Claude Code and Codex.** Pick a model and click Apply. Your original config is backed up first, and Restore puts back exactly the keys that were changed.
- **Automatic protocol conversion.** Each Copilot model only supports some upstream endpoints. The proxy reads each model's `supported_endpoints` and converts between Anthropic Messages, OpenAI Responses and Chat Completions as needed, so Claude Code can use GPT models and Codex can use Claude or Gemini.
- **OpenAI-format image API.** `/v1/images/generations` and `/v1/images/edits` (JSON and multipart). Requests for names such as `gpt-image-1` are mapped to the image model available on your account.
- **Tray app.** Closing the window keeps the service running in the system tray. It can also start at login.
- **Chinese and English UI.** Switch with the button in the title bar or in Settings.

## API

Base URL: `http://127.0.0.1:4141` (port is configurable). Any API key works unless you set one in Settings.

| Method | Path | Used by |
| --- | --- | --- |
| GET | `/v1/models` | Model list (OpenAI format; Anthropic format when the `anthropic-version` header is present) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions clients |
| POST | `/v1/responses` | Codex and other OpenAI Responses clients |
| POST | `/v1/messages` | Claude Code and other Anthropic clients |
| POST | `/v1/messages/count_tokens` | Claude Code (estimated) |
| POST | `/v1/images/generations` | OpenAI image generation |
| POST | `/v1/images/edits` | OpenAI image edits |
| POST | `/v1/embeddings` | Embeddings |

Example:

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}'

curl http://127.0.0.1:4141/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"A shiba inu wearing pilot goggles","size":"1024x1024"}'
```

## Download

Get the latest build from [Releases](https://github.com/xingyanan/GithubCopilotProxy/releases):

| Platform | File |
| --- | --- |
| Windows | `CopilotProxy-Setup-x.y.z.exe` (installer) or `CopilotProxy-x.y.z-portable.exe` |
| macOS | `CopilotProxy-x.y.z-arm64.dmg` / `CopilotProxy-x.y.z-x64.dmg` |
| Linux | `CopilotProxy-x.y.z-x86_64.AppImage` |

Builds are not code-signed. On Windows, SmartScreen may warn you: choose *More info → Run anyway*. On macOS, right-click the app and choose *Open* the first time.

## Usage

1. Open the app and click **Sign in with GitHub**. Enter the code on the GitHub page that opens.
2. Make sure the API service switch is on.
3. Under **One-click setup**, pick a model for Claude Code or Codex and click **Apply**, then restart that tool.

What gets written:

- **Claude Code**: the `env` block of `~/.claude/settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and the sonnet / opus / haiku aliases). Respects `CLAUDE_CONFIG_DIR`.
- **Codex**: `model`, `model_provider` and a `[model_providers.copilot-proxy]` table in `~/.codex/config.toml`, with `wire_api = "responses"`. Respects `CODEX_HOME`.

The first time, the original file is copied to `*.copilot-proxy.bak`. If you change the port or API key later, the configured tools are updated automatically.

## Build from source

Requires Node.js 18 or later.

```bash
npm install
npm start            # run the desktop app
npm test             # end-to-end tests against a mock Copilot upstream
npm run dist:exe     # Windows portable exe     → release/
npm run dist:dir     # Windows unpacked folder  → release/win-unpacked/
npm run dist:win     # Windows installer + portable
npm run dist:mac     # macOS dmg
npm run dist:linux   # Linux AppImage
```

If downloads from npm or Electron are slow, use a mirror, for example:

```bash
npm install --registry=https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

### Command line

The CLI shares its configuration (`~/.copilot-proxy`) with the desktop app.

```bash
npm run build
node dist/cli.js login            # device-code sign-in
node dist/cli.js serve --port 4141
node dist/cli.js models
node dist/cli.js apply-claude --model claude-sonnet-4.5 --small gpt-4.1
node dist/cli.js apply-codex --model gpt-5-codex --effort high
node dist/cli.js restore-claude
node dist/cli.js restore-codex
```

## Releasing

Pushing a tag that starts with `v` runs [`.github/workflows/release.yml`](.github/workflows/release.yml). It runs the tests, builds Windows, macOS and Linux packages, and publishes a GitHub Release with the files and a `SHA256SUMS.txt`. The app version is taken from the tag.

```bash
git tag v1.0.0
git push origin v1.0.0
```

Tags that contain a hyphen (for example `v1.1.0-beta.1`) are published as pre-releases.

## Project layout

```
src/core/          Proxy core, independent of Electron (also used by the CLI)
  auth.ts          Device flow and Copilot token refresh
  copilot.ts       Copilot API client
  models.ts        Model list parsing and name matching
  server.ts        HTTP server and routing
  translate/       Anthropic / Responses / Chat conversions
  integrations.ts  Claude Code and Codex config writer
src/main/          Electron main process, tray, preload
src/renderer/      UI
scripts/           Icon generation and tests
```

## Notes

- This project uses the same OAuth client and endpoints as the official Copilot editor extensions. It is not affiliated with or endorsed by GitHub, OpenAI or Anthropic. Make sure your usage follows the GitHub Copilot terms. Upstream behavior can change at any time.
- The service listens on `127.0.0.1` only by default. If you allow LAN access, an API key is required.
- Image generation in Copilot is in public preview and requires Copilot Pro, Pro+, Business or Enterprise. Organization admins may need to enable the image model in Copilot policies.
- Credentials and settings are stored in `~/.copilot-proxy/config.json`. Nothing is sent anywhere except GitHub and the Copilot API.

## License

[MIT](LICENSE)
