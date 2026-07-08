import {
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Download,
  ExternalLink,
  FolderOpen,
  HardDriveDownload,
  Inbox,
  Loader2,
  LogOut,
  MessageSquareText,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  Settings2,
  Smartphone,
  Trash2,
  UserRound,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import React from "react";
import type {
  AccountProfile,
  AccountStatus,
  AppSettings,
  DownloadRecord,
  DownloadRules,
  TransferKind,
  WebviewQrPayload,
  WebviewTelemetryPayload
} from "../shared/types";

export const MIN_UI_SCALE = 0.86;
export const MAX_UI_SCALE = 1.2;

export const downloadRuleOptions: Array<{ kind: TransferKind; label: string }> = [
  { kind: "document", label: "文档" },
  { kind: "image", label: "图片" },
  { kind: "video", label: "视频" },
  { kind: "audio", label: "音频" },
  { kind: "archive", label: "压缩包" },
  { kind: "code", label: "代码" },
  { kind: "app", label: "安装包" },
  { kind: "other", label: "其他" }
];

export type StatusMap = Record<string, AccountStatus>;

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function shortTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function eventTitle(kind: WebviewTelemetryPayload["kind"]): string {
  switch (kind) {
    case "online":
      return "已连接";
    case "login-required":
      return "需要扫码";
    case "download-url":
      return "开始保存";
    case "download-error":
      return "保存失败";
    case "scan-error":
      return "扫描异常";
    case "auto-click":
      return "自动接收";
    case "text-send-result":
      return "文本发送";
    case "session-preserved":
      return "会话保持";
    default:
      return "状态更新";
  }
}

export function statusMeta(status: AccountStatus): { label: string; tone: string; icon: React.ReactNode } {
  switch (status) {
    case "online":
      return { label: "在线", tone: "good", icon: <CheckCircle2 size={14} /> };
    case "login-required":
      return { label: "需要扫码", tone: "warn", icon: <CircleAlert size={14} /> };
    case "loading":
      return { label: "连接中", tone: "muted", icon: <Loader2 size={14} className="spin" /> };
    case "error":
      return { label: "异常", tone: "bad", icon: <CircleAlert size={14} /> };
    default:
      return { label: "待连接", tone: "muted", icon: <CircleAlert size={14} /> };
  }
}

export function accountInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "微";
}

export function clampUiScale(value: number): number {
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Number(value.toFixed(2))));
}

export function Sidebar({
  accounts,
  activeAccountId,
  statuses,
  newAccountName,
  completedDownloads,
  activeDownloads,
  onCreateAccount,
  onNewAccountNameChange,
  onSelectAccount
}: {
  accounts: AccountProfile[];
  activeAccountId: string;
  statuses: StatusMap;
  newAccountName: string;
  completedDownloads: number;
  activeDownloads: number;
  onCreateAccount: () => void;
  onNewAccountNameChange: (value: string) => void;
  onSelectAccount: (accountId: string) => void;
}) {
  return (
    <aside className="side-rail">
      <div className="brand">
        <div className="brand-mark">
          <HardDriveDownload size={22} />
        </div>
        <div>
          <h1>微信文件舱</h1>
          <p>WeChat File Dock</p>
        </div>
      </div>

      <div className="rail-section">
        <div className="section-title">
          <span>账号</span>
          <button className="icon-button" title="添加账号" onClick={onCreateAccount}>
            <Plus size={17} />
          </button>
        </div>
        <input
          className="account-input"
          value={newAccountName}
          onChange={(event) => onNewAccountNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCreateAccount();
            }
          }}
          placeholder="新账号名称"
        />

        <div className="account-list">
          {accounts.map((account) => {
            const meta = statusMeta(statuses[account.id] ?? "unknown");
            return (
              <button
                key={account.id}
                className={cx("account-row", account.id === activeAccountId && "is-active")}
                onClick={() => onSelectAccount(account.id)}
              >
                <span className="avatar" style={{ background: account.color }}>
                  {accountInitial(account.name)}
                </span>
                <span className="account-copy">
                  <strong>{account.name}</strong>
                  <small className={`state-pill ${meta.tone}`}>
                    {meta.icon}
                    {meta.label}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rail-stats">
        <div>
          <strong>{completedDownloads}</strong>
          <span>已保存</span>
        </div>
        <div>
          <strong>{activeDownloads}</strong>
          <span>进行中</span>
        </div>
      </div>
    </aside>
  );
}

export function TopBar({
  activeAccount,
  status,
  sessionOpen,
  uiScale,
  onScale,
  onReload,
  onToggleSession,
  onRename,
  onClearSession
}: {
  activeAccount?: AccountProfile;
  status: ReturnType<typeof statusMeta>;
  sessionOpen: boolean;
  uiScale: number;
  onScale: (value: number) => void;
  onReload: () => void;
  onToggleSession: () => void;
  onRename: () => void;
  onClearSession: () => void;
}) {
  return (
    <header className="topbar">
      <div className="identity">
        <span className="avatar xl" style={{ background: activeAccount?.color }}>
          {accountInitial(activeAccount?.name ?? "微")}
        </span>
        <div>
          <div className="title-line">
            <h2>{activeAccount?.name ?? "微信"}</h2>
            <span className={`state-pill ${status.tone}`}>
              {status.icon}
              {status.label}
            </span>
          </div>
          <p>文件与文本传输</p>
        </div>
      </div>

      <div className="top-actions">
        <div className="scale-control" title="界面缩放">
          <button className="scale-button" aria-label="缩小界面" onClick={() => onScale(uiScale - 0.04)}>
            <ZoomOut size={15} />
          </button>
          <input
            aria-label="界面缩放"
            type="range"
            min={MIN_UI_SCALE}
            max={MAX_UI_SCALE}
            step={0.02}
            value={uiScale}
            onChange={(event) => onScale(Number(event.target.value))}
          />
          <button className="scale-button" aria-label="放大界面" onClick={() => onScale(uiScale + 0.04)}>
            <ZoomIn size={15} />
          </button>
          <span>{Math.round(uiScale * 100)}%</span>
        </div>
        <button className="soft-button" onClick={onReload}>
          <RefreshCw size={16} />
          刷新
        </button>
        <button className="soft-button" onClick={onToggleSession}>
          <QrCode size={16} />
          {sessionOpen ? "收起" : "扫码"}
        </button>
        <button className="soft-button" onClick={onRename}>
          <UserRound size={16} />
          重命名
        </button>
        <button className="soft-button danger" onClick={onClearSession}>
          <LogOut size={16} />
          清登录
        </button>
      </div>
    </header>
  );
}

export function TransferDashboard({
  settings,
  currentStatus,
  sessionOpen,
  activeQr,
  textDraft,
  textStatus,
  textStatusMessage,
  latestDownloads,
  onAutoDownloadChange,
  onRuleChange,
  onChooseDownloadDir,
  onOpenPath,
  onTextDraftChange,
  onSendText,
  onCopyText,
  onQrAction
}: {
  settings: AppSettings;
  currentStatus: AccountStatus;
  sessionOpen: boolean;
  activeQr?: WebviewQrPayload;
  textDraft: string;
  textStatus: "idle" | "sending" | "sent" | "failed";
  textStatusMessage: string;
  latestDownloads: DownloadRecord[];
  onAutoDownloadChange: (value: boolean) => void;
  onRuleChange: (kind: keyof DownloadRules, value: boolean) => void;
  onChooseDownloadDir: () => void;
  onOpenPath: (targetPath: string) => void;
  onTextDraftChange: (value: string) => void;
  onSendText: () => void;
  onCopyText: () => void;
  onQrAction: () => void;
}) {
  const qrOpen = sessionOpen && currentStatus !== "online";

  return (
    <div className="dashboard">
      <section className="hero-panel">
        <div>
          <span className="eyebrow">接收</span>
          <h3>{settings.autoDownload ? "自动保存已开启" : "自动保存已暂停"}</h3>
          <p>{settings.downloadDir}</p>
        </div>
        <button
          className={cx("power-toggle", settings.autoDownload && "is-on")}
          onClick={() => onAutoDownloadChange(!settings.autoDownload)}
        >
          <span>{settings.autoDownload ? "ON" : "OFF"}</span>
        </button>
      </section>

      <section className="tool-grid">
        <div className="tool-panel">
          <div className="panel-head">
            <Download size={18} />
            <h3>接收规则</h3>
          </div>
          <div className="rule-row">
            {downloadRuleOptions.map((option) => (
              <label className="rule-chip" key={option.kind}>
                <input
                  type="checkbox"
                  checked={settings.downloadRules[option.kind]}
                  onChange={(event) => onRuleChange(option.kind, event.target.checked)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <div className="folder-box">
            <FolderOpen size={18} />
            <span>{settings.downloadDir}</span>
          </div>
          <div className="button-row">
            <button className="solid-button" onClick={onChooseDownloadDir}>
              选择目录
            </button>
            <button className="soft-button" onClick={() => onOpenPath(settings.downloadDir)}>
              <ExternalLink size={15} />
              打开
            </button>
          </div>
        </div>

        <div className="tool-panel text-tool">
          <div className="panel-head">
            <MessageSquareText size={18} />
            <h3>快速文本</h3>
          </div>
          <textarea
            value={textDraft}
            onChange={(event) => onTextDraftChange(event.target.value)}
            placeholder="写一段文本，发送到文件传输助手"
          />
          <div className="button-row">
            <button className="solid-button" onClick={onSendText} disabled={textStatus === "sending"}>
              {textStatus === "sending" ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
              {textStatus === "sending" ? "发送中" : "发送"}
            </button>
            <button className="soft-button" onClick={onCopyText}>
              <Clipboard size={15} />
              复制
            </button>
          </div>
          {textStatusMessage && <div className={`send-status ${textStatus}`}>{textStatusMessage}</div>}
        </div>

        <div className="tool-panel upload-tool">
          <div className="panel-head">
            <QrCode size={18} />
            <h3>扫码</h3>
          </div>
          <div className={cx("upload-box", qrOpen && "has-qr")}>
            {qrOpen && activeQr ? (
              <img className="inline-qr" src={activeQr.src} alt="微信登录二维码" />
            ) : qrOpen ? (
              <div className="inline-qr qr-placeholder">
                <Loader2 size={24} className="spin" />
                <span>获取二维码</span>
              </div>
            ) : (
              <>
                {currentStatus === "online" ? <CheckCircle2 size={34} /> : <Smartphone size={34} />}
                <strong>{currentStatus === "online" ? "已登录" : "微信扫一扫"}</strong>
                <span>{currentStatus === "online" ? "会话已保留" : "手机确认即可"}</span>
              </>
            )}
          </div>
          <button className="solid-button full" onClick={onQrAction}>
            {qrOpen || currentStatus === "online" ? "刷新" : "扫码"}
          </button>
        </div>
      </section>

      <DownloadsPanel downloads={latestDownloads} downloadDir={settings.downloadDir} onOpenPath={onOpenPath} />
    </div>
  );
}

function DownloadsPanel({
  downloads,
  downloadDir,
  onOpenPath
}: {
  downloads: DownloadRecord[];
  downloadDir: string;
  onOpenPath: (targetPath: string) => void;
}) {
  return (
    <section className="downloads-panel">
      <div className="panel-head spaced">
        <div>
          <h3>最近保存</h3>
          <p>{downloads.length ? "点击条目打开文件" : "还没有保存记录"}</p>
        </div>
        <button className="soft-button" onClick={() => onOpenPath(downloadDir)}>
          <FolderOpen size={15} />
          文件夹
        </button>
      </div>
      <div className="download-list">
        {downloads.length === 0 && <div className="empty-state">等待手机发来文件</div>}
        {downloads.map((record) => (
          <button key={record.id} className="download-item" onClick={() => onOpenPath(record.savePath)}>
            <span className={`download-state ${record.state}`}>
              {record.state === "completed" ? <CheckCircle2 size={16} /> : <Loader2 size={16} className="spin" />}
            </span>
            <span className="download-copy">
              <strong>{record.filename}</strong>
              <small>
                {record.accountName} · {formatBytes(record.receivedBytes || record.totalBytes)} · {shortTime(record.startedAt)}
              </small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function ActivityRail({
  events,
  settings,
  showSettings,
  onClearEvents,
  onToggleSettings,
  onUpdateSettings
}: {
  events: WebviewTelemetryPayload[];
  settings: AppSettings;
  showSettings: boolean;
  onClearEvents: () => void;
  onToggleSettings: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <aside className="activity-rail">
      <div className="activity-head">
        <div>
          <h3>事件</h3>
          <p>{events.length} 条</p>
        </div>
        <button className="icon-button" title="清空事件" onClick={onClearEvents}>
          <Trash2 size={16} />
        </button>
      </div>

      <div className="settings-card">
        <button className="settings-title" onClick={onToggleSettings}>
          <Settings2 size={16} />
          <span>偏好设置</span>
        </button>
        {showSettings && (
          <div className="settings-body">
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.organizeByDate}
                onChange={(event) => onUpdateSettings({ organizeByDate: event.target.checked })}
              />
              <span>按日期和账号归档</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.notifyWhenDownloaded}
                onChange={(event) => onUpdateSettings({ notifyWhenDownloaded: event.target.checked })}
              />
              <span>完成后通知</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                onChange={(event) => onUpdateSettings({ launchAtLogin: event.target.checked })}
              />
              <span>开机自启</span>
            </label>
          </div>
        )}
      </div>

      <div className="event-list">
        {events.length === 0 && (
          <div className="event-empty">
            <Inbox size={20} />
            <span>暂无事件</span>
          </div>
        )}
        {events.map((event, index) => (
          <div className={`event-item ${event.kind}`} key={`${event.accountId}-${event.kind}-${index}`}>
            <strong>{eventTitle(event.kind)}</strong>
            <span>{event.message ?? "状态更新"}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

