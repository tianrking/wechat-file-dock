export type TransferKind = "document" | "image" | "video" | "audio" | "archive" | "code" | "app" | "other";

export type AccountStatus = "unknown" | "login-required" | "online" | "loading" | "error";

export interface AccountProfile {
  id: string;
  name: string;
  partition: string;
  createdAt: string;
  lastUsedAt: string;
  color: string;
  enabled: boolean;
}

export type DownloadRules = Record<TransferKind, boolean>;

export interface AppSettings {
  downloadDir: string;
  autoDownload: boolean;
  downloadRules: DownloadRules;
  organizeByDate: boolean;
  launchAtLogin: boolean;
  notifyWhenDownloaded: boolean;
  uiScale: number;
}

export interface DownloadRecord {
  id: string;
  accountId: string;
  accountName: string;
  filename: string;
  savePath: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: string;
  endedAt?: string;
}

export interface BootstrapPayload {
  accounts: AccountProfile[];
  settings: AppSettings;
  downloads: DownloadRecord[];
  wechatPreloadUrl: string;
  appVersion: string;
}

export interface DownloadUpdatePayload {
  record: DownloadRecord;
}

export interface WebviewDownloadPayload {
  accountId: string;
  url: string;
  kind: TransferKind;
  filename?: string;
  sourceText?: string;
}

export interface WebviewQrPayload {
  accountId: string;
  src: string;
  detectedAt: string;
}

export interface WebviewSettingsPayload {
  accountId: string;
  autoDownload: boolean;
  rules: DownloadRules;
}

export interface WebviewTelemetryPayload {
  accountId: string;
  kind:
    | "login-required"
    | "online"
    | "auto-click"
    | "download-url"
    | "download-error"
    | "scan-error"
    | "text-send-result"
    | "session-preserved";
  message?: string;
  details?: unknown;
}
