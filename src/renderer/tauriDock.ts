import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AccountProfile,
  AppSettings,
  BootstrapPayload,
  DownloadUpdatePayload,
  WebviewDownloadPayload,
  WebviewQrPayload,
  WebviewTelemetryPayload
} from "../shared/types";

type DockApi = Window["wechatDock"];

type Unlisten = () => void;

function isTauriRuntime(): boolean {
  return isTauri();
}

function createListener<T>(eventName: string, callback: (payload: T) => void): Unlisten {
  let unlisten: Unlisten | null = null;
  void listen<T>(eventName, (event) => callback(event.payload)).then((dispose) => {
    unlisten = dispose;
  });

  return () => {
    unlisten?.();
  };
}

export function createTauriDockApi(): DockApi | null {
  if (!isTauriRuntime()) {
    return null;
  }

  return {
    bootstrap: () => invoke<BootstrapPayload>("bootstrap"),
    startEngines: () => invoke<boolean>("start_engines"),
    createAccount: (name: string) => invoke<AccountProfile>("create_account_command", { name }),
    updateAccount: (accountId: string, patch: Partial<Pick<AccountProfile, "name" | "enabled">>) =>
      invoke<AccountProfile[]>("update_account", { accountId, patch }),
    clearAccountSession: (accountId: string) => invoke<boolean>("clear_account_session", { accountId }),
    updateSettings: (patch: Partial<AppSettings>) => invoke<AppSettings>("update_settings", { patch }),
    chooseDownloadDir: () => invoke<string | null>("choose_download_dir"),
    openPath: (targetPath: string) => invoke<string>("open_path", { targetPath }),
    downloadFromUrl: (payload: WebviewDownloadPayload) => invoke<boolean>("download_from_url", { payload }),
    sendText: (accountId: string, text: string) => invoke<boolean>("send_text", { accountId, text }),
    sendTelemetry: (payload: WebviewTelemetryPayload) => {
      void invoke("send_telemetry", { payload });
    },
    onDownloadChanged: (callback: (payload: DownloadUpdatePayload) => void) => createListener("downloads-changed", callback),
    onWebviewTelemetry: (callback: (payload: WebviewTelemetryPayload) => void) => createListener("webview-telemetry", callback),
    onQrChanged: (callback: (payload: WebviewQrPayload) => void) => createListener("webview-qr", callback)
  };
}
