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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccountProfile,
  AccountStatus,
  AppSettings,
  DownloadRecord,
  DownloadRules,
  TransferKind,
  WebviewDownloadPayload,
  WebviewQrPayload,
  WebviewSettingsPayload,
  WebviewTelemetryPayload
} from "../shared/types";
import "./styles.css";

const WECHAT_FILEHELPER_URL = "https://filehelper.weixin.qq.com/";
const MIN_UI_SCALE = 0.86;
const MAX_UI_SCALE = 1.2;

const downloadRuleOptions: Array<{ kind: TransferKind; label: string }> = [
  { kind: "document", label: "文档" },
  { kind: "image", label: "图片" },
  { kind: "video", label: "视频" },
  { kind: "audio", label: "音频" },
  { kind: "archive", label: "压缩包" },
  { kind: "code", label: "代码" },
  { kind: "app", label: "安装包" },
  { kind: "other", label: "其他" }
];

type WebviewTag = HTMLElement & {
  send: (channel: string, ...args: unknown[]) => void;
  reload: () => void;
  setZoomFactor: (factor: number) => void;
};

type StatusMap = Record<string, AccountStatus>;
type WebviewMap = Record<string, WebviewTag | undefined>;
type QrMap = Record<string, WebviewQrPayload | undefined>;
type DockApi = Window["wechatDock"];

const previewAccount: AccountProfile = {
  id: "preview",
  name: "主微信",
  partition: "persist:wfd-preview",
  createdAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
  color: "#2b7fff",
  enabled: true
};

const previewDock: DockApi = {
  bootstrap: async () => ({
    accounts: [previewAccount],
    settings: {
      downloadDir: "D:\\Backup\\Downloads\\WeChatFileDock",
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
    },
    downloads: [],
    wechatPreloadUrl: "",
    appVersion: "preview"
  }),
  createAccount: async (name: string) => ({ ...previewAccount, id: `preview-${Date.now()}`, name: name || "新微信" }),
  updateAccount: async (_accountId, patch) => [{ ...previewAccount, ...patch }],
  clearAccountSession: async () => true,
  updateSettings: async (patch) => ({
    downloadDir: "D:\\Backup\\Downloads\\WeChatFileDock",
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
    uiScale: 1,
    ...patch
  }),
  chooseDownloadDir: async () => "D:\\Backup\\Downloads\\WeChatFileDock",
  openPath: async () => "",
  downloadFromUrl: async () => true,
  sendTelemetry: () => undefined,
  onDownloadChanged: () => () => undefined,
  onWebviewTelemetry: () => () => undefined
};

const dock: DockApi = window.wechatDock ?? previewDock;

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function formatBytes(value: number): string {
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

function shortTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function eventTitle(kind: WebviewTelemetryPayload["kind"]): string {
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

function statusMeta(status: AccountStatus): { label: string; tone: string; icon: React.ReactNode } {
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

function accountInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "微";
}

function clampUiScale(value: number): number {
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Number(value.toFixed(2))));
}

function AccountWebview({
  account,
  visible,
  zoom,
  settings,
  preloadUrl,
  register,
  onStatus,
  onDownloadUrl,
  onQr
}: {
  account: AccountProfile;
  visible: boolean;
  zoom: number;
  settings: AppSettings;
  preloadUrl: string;
  register: (accountId: string, webview: WebviewTag | undefined) => void;
  onStatus: (accountId: string, status: AccountStatus) => void;
  onDownloadUrl: (payload: WebviewDownloadPayload) => void;
  onQr: (payload: WebviewQrPayload) => void;
}) {
  const webviewRef = useRef<WebviewTag | null>(null);
  const readyRef = useRef(false);

  const sendSettings = useCallback(() => {
    if (!readyRef.current) {
      return;
    }

    webviewRef.current?.send("wfd:settings", {
      accountId: account.id,
      autoDownload: settings.autoDownload,
      rules: settings.downloadRules
    } satisfies WebviewSettingsPayload);
  }, [account.id, settings.autoDownload, settings.downloadRules]);

  useEffect(() => {
    if (readyRef.current) {
      webviewRef.current?.setZoomFactor(zoom);
    }
  }, [zoom]);

  useEffect(() => {
    sendSettings();
  }, [sendSettings]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const handleReady = () => {
      readyRef.current = true;
      webview.setZoomFactor(zoom);
      onStatus(account.id, "online");
      sendSettings();
    };
    const handleStart = () => {
      readyRef.current = false;
      onStatus(account.id, "loading");
    };
    const handleFail = () => {
      readyRef.current = false;
      onStatus(account.id, "error");
    };
    const handleMessage = (event: Event) => {
      const ipcEvent = event as Event & { channel?: string; args?: unknown[] };
      const payload = ipcEvent.args?.[0];
      if (ipcEvent.channel === "wfd:telemetry" && payload) {
        const telemetry = payload as WebviewTelemetryPayload;
        dock.sendTelemetry(telemetry);
        if (telemetry.kind === "login-required") {
          onStatus(account.id, "login-required");
        }
        if (telemetry.kind === "online") {
          onStatus(account.id, "online");
        }
      }

      if (ipcEvent.channel === "wfd:download-url" && payload) {
        onDownloadUrl(payload as WebviewDownloadPayload);
      }

      if (ipcEvent.channel === "wfd:qr" && payload) {
        onQr(payload as WebviewQrPayload);
      }
    };

    webview.addEventListener("dom-ready", handleReady);
    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("did-fail-load", handleFail);
    webview.addEventListener("ipc-message", handleMessage);

    return () => {
      webview.removeEventListener("dom-ready", handleReady);
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("did-fail-load", handleFail);
      webview.removeEventListener("ipc-message", handleMessage);
    };
  }, [account.id, onDownloadUrl, onQr, onStatus, sendSettings, zoom]);

  return (
    <webview
      ref={(node) => {
        webviewRef.current = node as WebviewTag | null;
        register(account.id, node ? (node as WebviewTag) : undefined);
      }}
      className={cx("wechat-engine", visible && "is-visible")}
      src={WECHAT_FILEHELPER_URL}
      partition={account.partition}
      preload={preloadUrl}
      webpreferences="contextIsolation=yes,nodeIntegration=no"
    />
  );
}

function App() {
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("");
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [preloadUrl, setPreloadUrl] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const [events, setEvents] = useState<WebviewTelemetryPayload[]>([]);
  const [qrs, setQrs] = useState<QrMap>({});
  const [textStatus, setTextStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [textStatusMessage, setTextStatusMessage] = useState("");
  const [showSession, setShowSession] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const webviews = useRef<WebviewMap>({});
  const activeAccountIdRef = useRef("");

  useEffect(() => {
    activeAccountIdRef.current = activeAccountId;
  }, [activeAccountId]);

  useEffect(() => {
    void dock.bootstrap().then((payload) => {
      setAccounts(payload.accounts);
      setSettings(payload.settings);
      setDownloads(payload.downloads);
      setPreloadUrl(payload.wechatPreloadUrl);
      setActiveAccountId(payload.accounts[0]?.id ?? "");
      setStatuses(Object.fromEntries(payload.accounts.map((account) => [account.id, "unknown"])));
    });

    const offDownload = dock.onDownloadChanged(({ record }) => {
      setDownloads((current) => [record, ...current.filter((entry) => entry.id !== record.id)].slice(0, 120));
    });
    const offTelemetry = dock.onWebviewTelemetry((payload) => {
      setEvents((current) => [payload, ...current].slice(0, 80));
      if (payload.kind === "text-send-result" && payload.accountId === activeAccountIdRef.current) {
        const method = asRecord(payload.details)?.method;
        if (method === "start") {
          setTextStatus("sending");
        } else if (String(payload.message ?? "").includes("failed")) {
          setTextStatus("failed");
        } else {
          setTextStatus("sent");
          setTextDraft("");
        }
        setTextStatusMessage(payload.message ?? "");
      }
    });

    return () => {
      offDownload();
      offTelemetry();
    };
  }, []);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) ?? accounts[0],
    [accounts, activeAccountId]
  );
  const currentStatus = activeAccount ? statuses[activeAccount.id] ?? "unknown" : "unknown";
  const status = statusMeta(currentStatus);
  const sessionOpen = showSession || currentStatus === "login-required" || currentStatus === "error";
  const activeQr = activeAccount ? qrs[activeAccount.id] : undefined;

  useEffect(() => {
    if (currentStatus === "login-required") {
      setShowSession(true);
    }
  }, [currentStatus]);

  const registerWebview = useCallback((accountId: string, webview: WebviewTag | undefined) => {
    webviews.current[accountId] = webview;
  }, []);

  const updateStatus = useCallback((accountId: string, nextStatus: AccountStatus) => {
    setStatuses((current) => ({
      ...current,
      [accountId]: nextStatus
    }));
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await dock.updateSettings(patch);
    setSettings(next);
  }, []);

  const updateRule = useCallback(
    (kind: keyof DownloadRules, value: boolean) => {
      if (!settings) {
        return;
      }

      void updateSettings({
        downloadRules: {
          ...settings.downloadRules,
          [kind]: value
        }
      });
    },
    [settings, updateSettings]
  );

  const updateUiScale = useCallback(
    (value: number) => {
      void updateSettings({ uiScale: clampUiScale(value) });
    },
    [updateSettings]
  );

  const handleDownloadUrl = useCallback(async (payload: WebviewDownloadPayload) => {
    const ok = await dock.downloadFromUrl(payload);
    if (!ok) {
      setEvents((current) => [
        {
          accountId: payload.accountId,
          kind: "download-error",
          message: "URL download handoff failed",
          details: payload
        },
        ...current
      ]);
    }
  }, []);

  const handleQr = useCallback((payload: WebviewQrPayload) => {
    setQrs((current) => ({
      ...current,
      [payload.accountId]: payload
    }));
  }, []);

  const createNewAccount = useCallback(async () => {
    const account = await dock.createAccount(newAccountName);
    setAccounts((current) => [...current, account]);
    setActiveAccountId(account.id);
    setStatuses((current) => ({ ...current, [account.id]: "unknown" }));
    setShowSession(true);
    setNewAccountName("");
  }, [newAccountName]);

  const renameActiveAccount = useCallback(async () => {
    if (!activeAccount) {
      return;
    }

    const name = window.prompt("账号名称", activeAccount.name);
    if (!name || name.trim() === activeAccount.name) {
      return;
    }

    const next = await dock.updateAccount(activeAccount.id, { name });
    setAccounts(next);
  }, [activeAccount]);

  const clearActiveSession = useCallback(async () => {
    if (!activeAccount) {
      return;
    }

    const ok = window.confirm(`清除「${activeAccount.name}」的本地登录状态？下次需要重新扫码。`);
    if (!ok) {
      return;
    }

    await dock.clearAccountSession(activeAccount.id);
    webviews.current[activeAccount.id]?.reload();
    updateStatus(activeAccount.id, "login-required");
    setShowSession(true);
  }, [activeAccount, updateStatus]);

  const reloadActive = useCallback(() => {
    if (!activeAccount) {
      return;
    }

    webviews.current[activeAccount.id]?.reload();
    setShowSession(true);
  }, [activeAccount]);

  const sendText = useCallback(() => {
    if (!activeAccount || !textDraft.trim()) {
      return;
    }

    setTextStatus("sending");
    setTextStatusMessage("正在发送到文件传输助手");
    webviews.current[activeAccount.id]?.send("wfd:send-text", textDraft);
  }, [activeAccount, textDraft]);

  const chooseDownloadDir = useCallback(async () => {
    const dir = await dock.chooseDownloadDir();
    if (dir && settings) {
      setSettings({ ...settings, downloadDir: dir });
    }
  }, [settings]);

  if (!settings) {
    return (
      <main className="loading-screen">
        <Loader2 className="spin" size={32} />
        <span>正在启动文件舱</span>
      </main>
    );
  }

  const completedDownloads = downloads.filter((record) => record.state === "completed").length;
  const activeDownloads = downloads.filter((record) => record.state === "progressing").length;
  const latestDownloads = downloads.slice(0, 9);
  const uiScale = clampUiScale(settings.uiScale);
  const webviewZoom = Math.min(1, Math.max(0.78, uiScale * 0.85));

  return (
    <main className="app-shell" style={{ "--ui-scale": uiScale } as React.CSSProperties}>
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
            <button className="icon-button" title="添加账号" onClick={createNewAccount}>
              <Plus size={17} />
            </button>
          </div>
          <input
            className="account-input"
            value={newAccountName}
            onChange={(event) => setNewAccountName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void createNewAccount();
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
                  onClick={() => setActiveAccountId(account.id)}
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

      <section className="main-stage">
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
              <p>后台保持登录，前台只做文件、文本和接收管理。</p>
            </div>
          </div>

          <div className="top-actions">
            <div className="scale-control" title="界面缩放">
              <button className="scale-button" aria-label="缩小界面" onClick={() => updateUiScale(uiScale - 0.04)}>
                <ZoomOut size={15} />
              </button>
              <input
                aria-label="界面缩放"
                type="range"
                min={MIN_UI_SCALE}
                max={MAX_UI_SCALE}
                step={0.02}
                value={uiScale}
                onChange={(event) => updateUiScale(Number(event.target.value))}
              />
              <button className="scale-button" aria-label="放大界面" onClick={() => updateUiScale(uiScale + 0.04)}>
                <ZoomIn size={15} />
              </button>
              <span>{Math.round(uiScale * 100)}%</span>
            </div>
            <button className="soft-button" onClick={reloadActive}>
              <RefreshCw size={16} />
              刷新
            </button>
            <button className="soft-button" onClick={() => setShowSession((value) => !value)}>
              <QrCode size={16} />
              {sessionOpen ? "收起" : "扫码"}
            </button>
            <button className="soft-button" onClick={renameActiveAccount}>
              <UserRound size={16} />
              重命名
            </button>
            <button className="soft-button danger" onClick={clearActiveSession}>
              <LogOut size={16} />
              清登录
            </button>
          </div>
        </header>

        <div className="dashboard">
          <section className="hero-panel">
            <div>
              <span className="eyebrow">自动接收</span>
              <h3>{settings.autoDownload ? "正在监听微信文件" : "接收已暂停"}</h3>
              <p>手机发来的文件会自动保存到本机，可按文档、图片、视频等类型过滤。</p>
            </div>
            <button
              className={cx("power-toggle", settings.autoDownload && "is-on")}
              onClick={() => void updateSettings({ autoDownload: !settings.autoDownload })}
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
                      onChange={(event) => updateRule(option.kind, event.target.checked)}
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
                <button className="solid-button" onClick={chooseDownloadDir}>
                  选择目录
                </button>
                <button className="soft-button" onClick={() => void dock.openPath(settings.downloadDir)}>
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
                onChange={(event) => setTextDraft(event.target.value)}
                placeholder="写一段文本，发送到文件传输助手"
              />
              <div className="button-row">
                <button className="solid-button" onClick={sendText} disabled={textStatus === "sending"}>
                  {textStatus === "sending" ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
                  {textStatus === "sending" ? "发送中" : "发送"}
                </button>
                <button className="soft-button" onClick={() => void navigator.clipboard.writeText(textDraft)}>
                  <Clipboard size={15} />
                  复制
                </button>
              </div>
              {textStatusMessage && <div className={`send-status ${textStatus}`}>{textStatusMessage}</div>}
            </div>

            <div className="tool-panel upload-tool">
              <div className="panel-head">
                <QrCode size={18} />
                <h3>微信扫码</h3>
              </div>
              <div className="upload-box">
                {currentStatus === "online" ? <CheckCircle2 size={34} /> : <Smartphone size={34} />}
                <strong>{currentStatus === "online" ? "已登录" : "用微信扫一扫"}</strong>
                <span>{currentStatus === "online" ? "会话已保留在本机" : "手机确认后自动进入接收状态"}</span>
              </div>
              <button className="solid-button full" onClick={() => setShowSession(true)}>
                {currentStatus === "online" ? "查看二维码" : "开始扫码"}
              </button>
            </div>
          </section>

          {sessionOpen && (
          <section className="session-drawer is-open">
            <div className="drawer-bar">
              <div>
                <strong>{currentStatus === "online" ? "微信已登录" : "微信扫码"}</strong>
                <span>{currentStatus === "online" ? "关闭窗口后仍会尽量保留会话" : "打开手机微信，对准二维码"}</span>
              </div>
              <button className="soft-button" onClick={reloadActive}>
                <RefreshCw size={15} />
                刷新
              </button>
            </div>

            <div className="qr-stage">
              <div className="qr-card">
                {activeQr ? (
                  <img src={activeQr.src} alt="微信登录二维码" />
                ) : (
                  <div className="qr-placeholder">
                    <Loader2 size={26} className="spin" />
                    <span>正在获取二维码</span>
                  </div>
                )}
              </div>
              <div className="qr-copy">
                <Smartphone size={28} />
                <h3>{currentStatus === "online" ? "可以开始传文件了" : "扫一扫登录"}</h3>
                <p>{currentStatus === "online" ? "新文件会进入自动接收流程，文本也会直接发送到文件传输助手。" : "扫码完成后，会进入后台接收状态。"}</p>
              </div>
            </div>
          </section>
          )}

          <section className="downloads-panel">
            <div className="panel-head spaced">
              <div>
                <h3>最近保存</h3>
                <p>{latestDownloads.length ? "点击条目打开文件" : "还没有保存记录"}</p>
              </div>
              <button className="soft-button" onClick={() => void dock.openPath(settings.downloadDir)}>
                <FolderOpen size={15} />
                文件夹
              </button>
            </div>
            <div className="download-list">
              {latestDownloads.length === 0 && <div className="empty-state">等待手机发来文件</div>}
              {latestDownloads.map((record) => (
                <button key={record.id} className="download-item" onClick={() => void dock.openPath(record.savePath)}>
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
        </div>
      </section>

      <aside className="activity-rail">
        <div className="activity-head">
          <div>
            <h3>事件</h3>
            <p>{events.length} 条</p>
          </div>
          <button className="icon-button" title="清空事件" onClick={() => setEvents([])}>
            <Trash2 size={16} />
          </button>
        </div>

        <div className="settings-card">
          <button className="settings-title" onClick={() => setShowSettings((value) => !value)}>
            <Settings2 size={16} />
            <span>偏好设置</span>
          </button>
          {showSettings && (
            <div className="settings-body">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.organizeByDate}
                  onChange={(event) => void updateSettings({ organizeByDate: event.target.checked })}
                />
                <span>按日期和账号归档</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.notifyWhenDownloaded}
                  onChange={(event) => void updateSettings({ notifyWhenDownloaded: event.target.checked })}
                />
                <span>完成后通知</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={settings.launchAtLogin}
                  onChange={(event) => void updateSettings({ launchAtLogin: event.target.checked })}
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

      <div className="engine-pool" aria-hidden="true">
        {accounts.map((account) => (
          <AccountWebview
            key={account.id}
            account={account}
            visible={false}
            zoom={webviewZoom}
            settings={settings}
            preloadUrl={preloadUrl}
            register={registerWebview}
            onStatus={updateStatus}
            onDownloadUrl={handleDownloadUrl}
            onQr={handleQr}
          />
        ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
