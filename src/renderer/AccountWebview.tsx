import { useCallback, useEffect, useRef } from "react";
import type {
  AccountProfile,
  AccountStatus,
  AppSettings,
  WebviewDownloadPayload,
  WebviewQrPayload,
  WebviewSettingsPayload,
  WebviewTelemetryPayload
} from "../shared/types";
import { cx } from "./dockUi";

const WECHAT_FILEHELPER_URL = "https://filehelper.weixin.qq.com/";

export type WebviewTag = HTMLElement & {
  send: (channel: string, ...args: unknown[]) => void;
  reload: () => void;
  setZoomFactor: (factor: number) => void;
};

export function AccountWebview({
  account,
  visible,
  zoom,
  settings,
  preloadUrl,
  register,
  onStatus,
  onTelemetry,
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
  onTelemetry: (payload: WebviewTelemetryPayload) => void;
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
        onTelemetry(telemetry);
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
  }, [account.id, onDownloadUrl, onQr, onStatus, onTelemetry, sendSettings, zoom]);

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

