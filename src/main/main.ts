import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  session,
  shell,
  Tray
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  AccountProfile,
  AppSettings,
  BootstrapPayload,
  DownloadRecord,
  WebviewDownloadPayload,
  WebviewTelemetryPayload
} from "../shared/types";
import { createAccount, loadState, saveState } from "./storage";
import { createTrayImage } from "./trayIcon";

const stableUserData = path.join(app.getPath("appData"), "WeChatFileDock");
app.setPath("userData", stableUserData);
app.setName("WeChat File Dock");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let sessionFlushCompleted = false;
let accounts: AccountProfile[] = [];
let settings: AppSettings;
let downloads: DownloadRecord[] = [];
const wiredPartitions = new Set<string>();
const activeDownloads = new Map<string, DownloadRecord>();
const pendingDownloads = new Map<string, { filename?: string; accountId: string }>();
const recentUrlRequests = new Map<string, number>();
const downloaderWindows = new Map<string, BrowserWindow>();

function getRendererPreloadPath(): string {
  return path.join(__dirname, "../preload/bridgePreload.js");
}

function getWechatPreloadPath(): string {
  return path.join(__dirname, "../preload/wechatPreload.js");
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || `download-${Date.now()}`;
}

function filenameFromUrl(rawUrl: string, fallback: string): string {
  try {
    const url = new URL(rawUrl);
    const candidates = [
      url.searchParams.get("filename"),
      url.searchParams.get("fileName"),
      url.searchParams.get("name"),
      path.basename(decodeURIComponent(url.pathname))
    ].filter(Boolean) as string[];

    return sanitizeFilename(candidates.find((candidate) => candidate.includes(".")) ?? candidates[0] ?? fallback);
  } catch {
    return sanitizeFilename(fallback);
  }
}

function todayFolder(): string {
  return new Date().toISOString().slice(0, 10);
}

function uniquePath(target: string): string {
  if (!fs.existsSync(target)) {
    return target;
  }

  const parsed = path.parse(target);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function persist(): void {
  saveState({
    accounts,
    settings,
    downloads: downloads.slice(0, 120)
  });
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function findAccountByPartition(partition: string): AccountProfile | undefined {
  return accounts.find((account) => account.partition === partition);
}

function findAccountById(accountId: string): AccountProfile | undefined {
  return accounts.find((account) => account.id === accountId);
}

function pendingDownloadKey(accountId: string, url: string): string {
  return `${accountId}:${url}`;
}

function clampUiScale(value: unknown, fallback: number): number {
  const next = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(1.2, Math.max(0.86, Number(next.toFixed(2))));
}

async function flushAccountSessions(): Promise<void> {
  await Promise.allSettled(
    accounts.map(async (account) => {
      const ses = session.fromPartition(account.partition);
      await ses.cookies.flushStore();

      const flushStorageData = (ses as typeof ses & { flushStorageData?: () => Promise<void> }).flushStorageData;
      if (typeof flushStorageData === "function") {
        await flushStorageData.call(ses);
      }
    })
  );
}

function getDownloaderWindow(account: AccountProfile): BrowserWindow {
  const existing = downloaderWindows.get(account.id);
  if (existing && !existing.isDestroyed()) {
    return existing;
  }

  const win = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      partition: account.partition,
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  void win.loadURL("about:blank");
  win.on("closed", () => downloaderWindows.delete(account.id));
  downloaderWindows.set(account.id, win);
  return win;
}

function ensureSessionForAccount(account: AccountProfile): void {
  if (wiredPartitions.has(account.partition)) {
    return;
  }

  const ses = session.fromPartition(account.partition);
  wiredPartitions.add(account.partition);

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "notifications" || permission === "clipboard-read" || permission === "clipboard-sanitized-write");
  });

  ses.webRequest.onBeforeRequest(
    {
      urls: [
        "*://*.qq.com/*webwxlogout*",
        "*://*.wechat.com/*webwxlogout*",
        "*://*.weixin.qq.com/*webwxlogout*",
        "*://web.wechat.com/*webwxlogout*"
      ]
    },
    (details, callback) => {
      const accountForRequest = findAccountByPartition(account.partition) ?? account;
      broadcast("webview:telemetry", {
        accountId: accountForRequest.id,
        kind: "session-preserved",
        message: "Blocked WeChat logout request",
        details: {
          method: details.method,
          url: details.url.slice(0, 180)
        }
      } satisfies WebviewTelemetryPayload);
      callback({ cancel: true });
    }
  );

  ses.on("will-download", (_event, item) => {
    const accountForDownload = findAccountByPartition(account.partition) ?? account;
    const pendingKey = pendingDownloadKey(accountForDownload.id, item.getURL());
    const pending = pendingDownloads.get(pendingKey);
    const filename = sanitizeFilename(pending?.filename ?? item.getFilename());
    pendingDownloads.delete(pendingKey);
    const baseDir = settings.organizeByDate
      ? path.join(settings.downloadDir, todayFolder(), accountForDownload.name)
      : path.join(settings.downloadDir, accountForDownload.name);
    fs.mkdirSync(baseDir, { recursive: true });

    const savePath = uniquePath(path.join(baseDir, filename));
    item.setSavePath(savePath);

    const id = randomUUID();
    const record: DownloadRecord = {
      id,
      accountId: accountForDownload.id,
      accountName: accountForDownload.name,
      filename,
      savePath,
      url: item.getURL(),
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: new Date().toISOString()
    };

    activeDownloads.set(id, record);
    downloads = [record, ...downloads].slice(0, 120);
    persist();
    broadcast("downloads:changed", { record });

    item.on("updated", (_event, state) => {
      record.state = state === "interrupted" ? "interrupted" : "progressing";
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      broadcast("downloads:changed", { record });
    });

    item.once("done", (_event, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.endedAt = new Date().toISOString();
      activeDownloads.delete(id);
      downloads = [record, ...downloads.filter((entry) => entry.id !== id)].slice(0, 120);
      persist();
      broadcast("downloads:changed", { record });

      if (state === "completed" && settings.notifyWhenDownloaded && Notification.isSupported()) {
        new Notification({
          title: "微信文件已下载",
          body: `${accountForDownload.name}: ${filename}`
        }).show();
      }
    });
  });
}

function requestDownloadFromUrl(payload: WebviewDownloadPayload): boolean {
  const account = findAccountById(payload.accountId);
  if (!account || !/^https?:\/\//i.test(payload.url)) {
    return false;
  }

  const now = Date.now();
  const key = `${payload.accountId}:${payload.url}`;
  const lastRequest = recentUrlRequests.get(key) ?? 0;
  if (now - lastRequest < 90_000) {
    return true;
  }

  recentUrlRequests.set(key, now);
  for (const [entryKey, timestamp] of recentUrlRequests.entries()) {
    if (now - timestamp > 180_000) {
      recentUrlRequests.delete(entryKey);
    }
  }

  const filename = payload.filename
    ? sanitizeFilename(payload.filename)
    : filenameFromUrl(payload.url, `${payload.kind}-${now}`);
  pendingDownloads.set(pendingDownloadKey(account.id, payload.url), {
    accountId: account.id,
    filename
  });

  getDownloaderWindow(account).webContents.downloadURL(payload.url);
  broadcast("webview:telemetry", {
    accountId: payload.accountId,
    kind: "download-url",
    message: "Download started with account session",
    details: {
      filename,
      kind: payload.kind
    }
  } satisfies WebviewTelemetryPayload);
  return true;
}

function configureLaunchAtLogin(): void {
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    openAsHidden: true
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 920,
    minHeight: 620,
    title: "WeChat File Dock",
    backgroundColor: "#f7f8fb",
    show: false,
    webPreferences: {
      preload: getRendererPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (process.env.WFD_OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

function createTray(): void {
  tray = new Tray(createTrayImage());
  tray.setToolTip("WeChat File Dock");

  const menu = Menu.buildFromTemplate([
    {
      label: "打开工作台",
      click: () => mainWindow?.show()
    },
    {
      label: "打开下载目录",
      click: () => void shell.openPath(settings.downloadDir)
    },
    { type: "separator" },
    {
      label: "彻底退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on("double-click", () => mainWindow?.show());
}

function registerIpc(): void {
  ipcMain.handle("app:bootstrap", (): BootstrapPayload => ({
    accounts,
    settings,
    downloads,
    wechatPreloadUrl: pathToFileURL(getWechatPreloadPath()).toString(),
    appVersion: app.getVersion()
  }));

  ipcMain.handle("accounts:create", (_event, name: string) => {
    const account = createAccount(name, accounts.length);
    accounts = [...accounts, account];
    ensureSessionForAccount(account);
    persist();
    return account;
  });

  ipcMain.handle("accounts:update", (_event, accountId: string, patch: Partial<Pick<AccountProfile, "name" | "enabled">>) => {
    accounts = accounts.map((account) =>
      account.id === accountId
        ? {
            ...account,
            ...patch,
            name: patch.name?.trim() || account.name,
            lastUsedAt: new Date().toISOString()
          }
        : account
    );
    persist();
    return accounts;
  });

  ipcMain.handle("accounts:clear-session", async (_event, accountId: string) => {
    const account = accounts.find((entry) => entry.id === accountId);
    if (!account) {
      return false;
    }

    await session.fromPartition(account.partition).clearStorageData();
    return true;
  });

  ipcMain.handle("settings:update", (_event, patch: Partial<AppSettings>) => {
    settings = {
      ...settings,
      ...patch,
      downloadRules: {
        ...settings.downloadRules,
        ...(patch.downloadRules ?? {})
      },
      uiScale: clampUiScale(patch.uiScale, settings.uiScale)
    };
    fs.mkdirSync(settings.downloadDir, { recursive: true });
    configureLaunchAtLogin();
    persist();
    return settings;
  });

  ipcMain.handle("downloads:from-url", (_event, payload: WebviewDownloadPayload) => {
    try {
      const ok = requestDownloadFromUrl(payload);
      if (!ok) {
        broadcast("webview:telemetry", {
          accountId: payload.accountId,
          kind: "download-error",
          message: "Download URL was rejected",
          details: payload
        } satisfies WebviewTelemetryPayload);
      }
      return ok;
    } catch (error) {
      broadcast("webview:telemetry", {
        accountId: payload.accountId,
        kind: "download-error",
        message: error instanceof Error ? error.message : String(error),
        details: payload
      } satisfies WebviewTelemetryPayload);
      return false;
    }
  });

  ipcMain.handle("dialog:choose-download-dir", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "选择自动下载目录",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: settings.downloadDir
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    settings = {
      ...settings,
      downloadDir: result.filePaths[0]
    };
    persist();
    return settings.downloadDir;
  });

  ipcMain.handle("shell:open-path", async (_event, targetPath: string) => {
    return shell.openPath(targetPath);
  });

  ipcMain.on("webview:telemetry", (_event, payload: WebviewTelemetryPayload) => {
    broadcast("webview:telemetry", payload);

    if (payload.kind === "login-required") {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

app.on("before-quit", (event) => {
  isQuitting = true;

  if (!sessionFlushCompleted) {
    event.preventDefault();
    sessionFlushCompleted = true;
    void flushAccountSessions().finally(() => app.quit());
    return;
  }

  for (const win of downloaderWindows.values()) {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
});

app.whenReady().then(() => {
  const state = loadState();
  accounts = state.accounts;
  settings = state.settings;
  downloads = state.downloads;

  fs.mkdirSync(settings.downloadDir, { recursive: true });
  accounts.forEach(ensureSessionForAccount);
  configureLaunchAtLogin();
  registerIpc();
  createWindow();
  createTray();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});
