import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AccountProfile,
  AccountStatus,
  AppSettings,
  DownloadRecord,
  DownloadRules,
  WebviewDownloadPayload,
  WebviewQrPayload,
  WebviewTelemetryPayload
} from "../shared/types";
import { AccountWebview, type WebviewTag } from "./AccountWebview";
import {
  ActivityRail,
  Sidebar,
  TopBar,
  TransferDashboard,
  clampUiScale,
  statusMeta,
  type StatusMap
} from "./dockUi";
import { createTauriDockApi } from "./tauriDock";
import "./styles.css";

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

const previewSettings: AppSettings = {
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
};

const previewDock: DockApi = {
  bootstrap: async () => ({
    accounts: [previewAccount],
    settings: previewSettings,
    downloads: [],
    wechatPreloadUrl: "",
    appVersion: "preview"
  }),
  startEngines: async () => true,
  refreshAccountEngine: async () => true,
  createAccount: async (name: string) => ({ ...previewAccount, id: `preview-${Date.now()}`, name: name || "新微信" }),
  updateAccount: async (_accountId, patch) => [{ ...previewAccount, ...patch }],
  clearAccountSession: async () => true,
  updateSettings: async (patch) => ({
    ...previewSettings,
    ...patch,
    downloadRules: {
      ...previewSettings.downloadRules,
      ...(patch.downloadRules ?? {})
    }
  }),
  chooseDownloadDir: async () => previewSettings.downloadDir,
  openPath: async () => "",
  downloadFromUrl: async () => true,
  sendText: async () => true,
  sendTelemetry: () => undefined,
  onDownloadChanged: () => () => undefined,
  onWebviewTelemetry: () => () => undefined,
  onQrChanged: () => () => undefined
};

const tauriDock = createTauriDockApi();
const dock: DockApi = window.wechatDock ?? tauriDock ?? previewDock;
const isTauriRuntime = Boolean(tauriDock);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
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
  const [bootError, setBootError] = useState("");
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
    void dock
      .bootstrap()
      .then((payload) => {
        setAccounts(payload.accounts);
        setSettings(payload.settings);
        setDownloads(payload.downloads);
        setPreloadUrl(payload.wechatPreloadUrl);
        setActiveAccountId(payload.accounts[0]?.id ?? "");
        setStatuses(Object.fromEntries(payload.accounts.map((account) => [account.id, "unknown"])));
        void dock.startEngines?.().catch((error) => {
          setEvents((current) => [
            {
              accountId: payload.accounts[0]?.id ?? "",
              kind: "scan-error",
              message: `微信会话引擎启动失败：${error instanceof Error ? error.message : String(error)}`
            },
            ...current
          ]);
        });
      })
      .catch((error) => {
        setBootError(error instanceof Error ? error.message : String(error));
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
    const offQr = dock.onQrChanged((payload) => {
      setQrs((current) => ({
        ...current,
        [payload.accountId]: payload
      }));
    });

    return () => {
      offDownload();
      offTelemetry();
      offQr();
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

  const refreshActive = useCallback(() => {
    if (!activeAccount) {
      return;
    }

    if (dock.refreshAccountEngine) {
      void dock.refreshAccountEngine(activeAccount.id);
      return;
    }

    webviews.current[activeAccount.id]?.reload();
  }, [activeAccount]);

  const openQrOrRefresh = useCallback(() => {
    if (sessionOpen || currentStatus === "online") {
      refreshActive();
      return;
    }

    setShowSession(true);
  }, [currentStatus, refreshActive, sessionOpen]);

  const sendText = useCallback(() => {
    if (!activeAccount || !textDraft.trim()) {
      return;
    }

    setTextStatus("sending");
    setTextStatusMessage("正在发送到文件传输助手");

    if (dock.sendText) {
      void dock.sendText(activeAccount.id, textDraft).then((ok) => {
        if (!ok) {
          setTextStatus("failed");
          setTextStatusMessage("发送失败：微信会话尚未准备好");
        }
      });
      return;
    }

    webviews.current[activeAccount.id]?.send("wfd:send-text", textDraft);
  }, [activeAccount, textDraft]);

  const chooseDownloadDir = useCallback(async () => {
    const dir = await dock.chooseDownloadDir();
    if (dir && settings) {
      setSettings({ ...settings, downloadDir: dir });
    }
  }, [settings]);

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

  const handleTelemetry = useCallback((payload: WebviewTelemetryPayload) => {
    dock.sendTelemetry(payload);
  }, []);

  if (!settings) {
    return (
      <main className="loading-screen">
        <span>{bootError ? `启动失败：${bootError}` : "正在启动文件舱"}</span>
      </main>
    );
  }

  const completedDownloads = downloads.filter((record) => record.state === "completed").length;
  const activeDownloads = downloads.filter((record) => record.state === "progressing").length;
  const latestDownloads = downloads;
  const uiScale = clampUiScale(settings.uiScale);
  const webviewZoom = Math.min(1, Math.max(0.78, uiScale * 0.85));

  return (
    <main className="app-shell" style={{ "--ui-scale": uiScale } as React.CSSProperties}>
      <Sidebar
        accounts={accounts}
        activeAccountId={activeAccountId}
        statuses={statuses}
        newAccountName={newAccountName}
        completedDownloads={completedDownloads}
        activeDownloads={activeDownloads}
        onCreateAccount={createNewAccount}
        onNewAccountNameChange={setNewAccountName}
        onSelectAccount={setActiveAccountId}
      />

      <section className="main-stage">
        <TopBar
          activeAccount={activeAccount}
          status={status}
          sessionOpen={sessionOpen}
          uiScale={uiScale}
          onScale={updateUiScale}
          onReload={refreshActive}
          onToggleSession={() => setShowSession((value) => !value)}
          onRename={renameActiveAccount}
          onClearSession={clearActiveSession}
        />

        <TransferDashboard
          settings={settings}
          currentStatus={currentStatus}
          sessionOpen={sessionOpen}
          activeQr={activeQr}
          textDraft={textDraft}
          textStatus={textStatus}
          textStatusMessage={textStatusMessage}
          latestDownloads={latestDownloads}
          onAutoDownloadChange={(value) => void updateSettings({ autoDownload: value })}
          onRuleChange={updateRule}
          onChooseDownloadDir={() => void chooseDownloadDir()}
          onOpenPath={(targetPath) => void dock.openPath(targetPath)}
          onTextDraftChange={setTextDraft}
          onSendText={sendText}
          onCopyText={() => void navigator.clipboard.writeText(textDraft)}
          onQrAction={openQrOrRefresh}
        />
      </section>

      <ActivityRail
        events={events}
        settings={settings}
        showSettings={showSettings}
        onClearEvents={() => setEvents([])}
        onToggleSettings={() => setShowSettings((value) => !value)}
        onUpdateSettings={(patch) => void updateSettings(patch)}
      />

      {!isTauriRuntime && (
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
              onTelemetry={handleTelemetry}
              onDownloadUrl={handleDownloadUrl}
              onQr={handleQr}
            />
          ))}
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
