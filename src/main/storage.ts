import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AccountProfile, AppSettings, DownloadRecord } from "../shared/types";

interface StoredState {
  accounts: AccountProfile[];
  settings: AppSettings;
  downloads: DownloadRecord[];
}

const palette = ["#2478ff", "#19a974", "#f08c00", "#d9480f", "#7048e8", "#0ca678"];

function clampUiScale(value: unknown): number {
  const next = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(1.2, Math.max(0.86, Number(next.toFixed(2))));
}

export function getStorePath(): string {
  return path.join(app.getPath("userData"), "state.json");
}

export function getDefaultSettings(): AppSettings {
  return {
    downloadDir: path.join(app.getPath("downloads"), "WeChatFileDock"),
    autoDownload: true,
    downloadRules: {
      document: true,
      image: true,
      video: true,
      audio: true,
      archive: true,
      code: true,
      app: true,
      other: true
    },
    organizeByDate: true,
    launchAtLogin: false,
    notifyWhenDownloaded: true,
    uiScale: 1
  };
}

export function createDefaultAccount(): AccountProfile {
  const id = randomUUID();
  return {
    id,
    name: "主微信",
    partition: `persist:wfd-${id}`,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    color: palette[0],
    enabled: true
  };
}

export function loadState(): StoredState {
  const defaults: StoredState = {
    accounts: [createDefaultAccount()],
    settings: getDefaultSettings(),
    downloads: []
  };

  const file = getStorePath();
  if (!fs.existsSync(file)) {
    saveState(defaults);
    return defaults;
  }

  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    const accounts = Array.isArray(parsed.accounts) && parsed.accounts.length > 0 ? parsed.accounts : defaults.accounts;
    const oldRules = parsed.settings?.downloadRules as Partial<Record<string, boolean>> | undefined;
    const oldFileEnabled = oldRules?.file ?? true;

    return {
      accounts,
      settings: {
        ...defaults.settings,
        ...(parsed.settings ?? {}),
        downloadRules: {
          ...defaults.settings.downloadRules,
          document: oldRules?.document ?? oldFileEnabled,
          image: oldRules?.image ?? defaults.settings.downloadRules.image,
          video: oldRules?.video ?? defaults.settings.downloadRules.video,
          audio: oldRules?.audio ?? oldFileEnabled,
          archive: oldRules?.archive ?? oldFileEnabled,
          code: oldRules?.code ?? oldFileEnabled,
          app: oldRules?.app ?? oldFileEnabled,
          other: oldRules?.other ?? oldFileEnabled
        },
        uiScale: clampUiScale(parsed.settings?.uiScale)
      },
      downloads: Array.isArray(parsed.downloads) ? parsed.downloads.slice(0, 120) : []
    };
  } catch {
    const backup = `${file}.broken-${Date.now()}`;
    fs.copyFileSync(file, backup);
    saveState(defaults);
    return defaults;
  }
}

export function saveState(state: StoredState): void {
  const file = getStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function createAccount(name: string, existingCount: number): AccountProfile {
  const id = randomUUID();
  return {
    id,
    name: name.trim() || `微信 ${existingCount + 1}`,
    partition: `persist:wfd-${id}`,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    color: palette[existingCount % palette.length],
    enabled: true
  };
}
