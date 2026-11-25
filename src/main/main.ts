import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, clipboard, safeStorage, net, Notification, dialog } from "electron";
import * as path from "node:path";
import * as os from "node:os";
import { AppCore } from "../core/app";
import { L } from "../core/i18n";
import type { SecretCodec } from "../core/store";
import type { AppState } from "../shared/types";

const isDev = process.argv.includes("--dev");
const startHidden = process.argv.includes("--hidden");
const ASSETS = path.join(__dirname, "..", "..", "assets");

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let core: AppCore;
let quitting = false;
let trayHintShown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(bootstrap);
}

/** 用系统钥匙串（DPAPI / Keychain / libsecret）加密 GitHub token */
const safeCodec: SecretCodec = {
  encrypt: (s) => (safeStorage.isEncryptionAvailable() ? "enc:" + safeStorage.encryptString(s).toString("base64") : "plain:" + Buffer.from(s).toString("base64")),
  decrypt: (s) => {
    if (s.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(s.slice(4), "base64"));
    if (s.startsWith("plain:")) return Buffer.from(s.slice(6), "base64").toString("utf8");
    return s;
  },
};

async function bootstrap() {
  app.setAppUserModelId("io.github.xingyanan.copilotproxy");
  core = new AppCore({
    dataDir: process.env.COPILOT_PROXY_HOME || path.join(os.homedir(), ".copilot-proxy"),
    version: app.getVersion(),
    systemLocale: app.getLocale(),
    codec: safeCodec,
    // net.fetch 走 Chromium 网络栈：自动使用系统代理 / PAC / 企业证书
    fetch: (useSystemProxy) => (useSystemProxy ? ((url, init) => net.fetch(url, init as any)) : globalThis.fetch),
  });

  core.on("state", (s: AppState) => {
    win?.webContents.send("state", s);
    updateTray(s);
  });

  registerIpc();
  createTray();
  const s = core.settings;
  createWindow(!(startHidden || s.startMinimized));
  await core.init();
  updateTray(core.state());
}

function createWindow(show: boolean) {
  win = new BrowserWindow({
    width: 520,
    height: 420,
    minWidth: 460,
    minHeight: 360,
    show: false,
    title: "Copilot Proxy",
    icon: path.join(ASSETS, "icon.png"),
    backgroundColor: "#F0F2F5",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => { if (show) win?.show(); if (isDev) win?.webContents.openDevTools({ mode: "detach" }); });
  win.on("close", (e) => {
    if (!quitting && core.settings.closeToTray) {
      e.preventDefault();
      win?.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: L("Copilot Proxy 仍在后台运行", "Copilot Proxy is still running"), body: L("API 服务继续工作，点击托盘图标可重新打开窗口。", "The API service keeps running. Click the tray icon to reopen the window."), silent: true }).show();
      }
    }
  });
  win.on("closed", () => { win = undefined; });
  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

function showWindow() {
  if (!win) createWindow(true);
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function trayImage(running: boolean) {
  const img = nativeImage.createFromPath(path.join(ASSETS, running ? "tray.png" : "tray-off.png"));
  if (process.platform === "darwin") img.setTemplateImage(false);
  return img;
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.setToolTip("Copilot Proxy");
  tray.on("click", () => {
    if (process.platform === "darwin") return; // macOS 点击显示菜单
    if (win?.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
  tray.on("double-click", () => showWindow());
}

let lastTrayKey = "";
function updateTray(s: AppState) {
  if (!tray) return;
  const key = JSON.stringify([s.lang, s.proxy.running, s.proxy.url, s.loggedIn, s.user?.login, s.integrations.claude.applied, s.integrations.codex.applied]);
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  tray.setImage(trayImage(s.proxy.running));
  tray.setToolTip(`Copilot Proxy\n${s.proxy.running ? L("运行中 ", "Running ") + s.proxy.url : L("已停止", "Stopped")}${s.user ? "\n" + s.user.login : ""}`);
  const menu = Menu.buildFromTemplate([
    { label: L("打开主窗口", "Open window"), click: showWindow },
    { type: "separator" },
    { label: s.proxy.running ? L("API 服务运行中 ", "API service running ") + s.proxy.url : L("API 服务已停止", "API service stopped"), enabled: false },
    s.proxy.running
      ? { label: L("停止服务", "Stop service"), click: () => core.stopProxy() }
      : { label: L("启动服务", "Start service"), click: () => core.startProxy().catch((e) => dialog.showErrorBox(L("启动失败", "Failed to start"), e.message)) },
    { label: L("复制服务地址", "Copy base URL"), click: () => clipboard.writeText(s.proxy.url + "/v1") },
    { type: "separator" },
    {
      label: s.integrations.claude.applied ? L("Claude Code：已配置（点击还原）", "Claude Code: configured (click to restore)") : L("配置 Claude Code", "Configure Claude Code"),
      enabled: s.loggedIn,
      click: () => safely(() => (core.state().integrations.claude.applied ? core.restoreClaude() : core.applyClaude())),
    },
    {
      label: s.integrations.codex.applied ? L("Codex：已配置（点击还原）", "Codex: configured (click to restore)") : L("配置 Codex", "Configure Codex"),
      enabled: s.loggedIn,
      click: () => safely(() => (core.state().integrations.codex.applied ? core.restoreCodex() : core.applyCodex())),
    },
    { type: "separator" },
    { label: s.loggedIn ? `GitHub: ${s.user?.login ?? ""}` : L("未登录 GitHub", "Not signed in to GitHub"), enabled: false },
    { label: L("退出", "Quit"), click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function safely(fn: () => unknown) {
  try { fn(); } catch (e: any) { dialog.showErrorBox(L("操作失败", "Operation failed"), e?.message ?? String(e)); }
}

function registerIpc() {
  const handlers: Record<string, (...args: any[]) => unknown> = {
    getState: () => core.state(),
    startLogin: () => core.startLogin(),
    cancelLogin: () => core.cancelLogin(),
    logout: () => core.logout(),
    refreshModels: () => core.refreshModels().then(() => true),
    startProxy: () => core.startProxy(),
    stopProxy: () => core.stopProxy(),
    updateSettings: async (patch: any) => {
      const s = await core.updateSettings(patch);
      if (patch && "launchAtLogin" in patch) {
        app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin, args: ["--hidden"] });
      }
      return s;
    },
    applyClaude: () => core.applyClaude(),
    restoreClaude: () => core.restoreClaude(),
    applyCodex: () => core.applyCodex(),
    restoreCodex: () => core.restoreCodex(),
    openExternal: (url: string) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); },
    copy: (text: string) => clipboard.writeText(text),
    quit: () => { quitting = true; app.quit(); },
  };
  ipcMain.handle("invoke", async (_e, method: string, ...args: any[]) => {
    const fn = handlers[method];
    if (!fn) throw new Error(`Unknown method ${method}`);
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}

app.on("window-all-closed", () => {
  // 托盘常驻：所有窗口关闭也不退出（除非关闭了"最小化到托盘"）
  if (!core?.settings.closeToTray) { quitting = true; app.quit(); }
});

app.on("activate", () => showWindow());

app.on("before-quit", (e) => {
  quitting = true;
  if (core && core.server.running) {
    e.preventDefault();
    core.dispose().finally(() => { tray?.destroy(); tray = undefined; app.exit(0); });
  }
});
