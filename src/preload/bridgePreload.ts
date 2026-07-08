import { contextBridge, ipcRenderer } from "electron";
import type {
  AccountProfile,
  AppSettings,
  BootstrapPayload,
  DownloadUpdatePayload,
  WebviewDownloadPayload,
  WebviewQrPayload,
  WebviewTelemetryPayload
} from "../shared/types";

const api = {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap") as Promise<BootstrapPayload>,
  createAccount: (name: string) => ipcRenderer.invoke("accounts:create", name) as Promise<AccountProfile>,
  updateAccount: (accountId: string, patch: Partial<Pick<AccountProfile, "name" | "enabled">>) =>
    ipcRenderer.invoke("accounts:update", accountId, patch) as Promise<AccountProfile[]>,
  clearAccountSession: (accountId: string) => ipcRenderer.invoke("accounts:clear-session", accountId) as Promise<boolean>,
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", patch) as Promise<AppSettings>,
  chooseDownloadDir: () => ipcRenderer.invoke("dialog:choose-download-dir") as Promise<string | null>,
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:open-path", targetPath) as Promise<string>,
  downloadFromUrl: (payload: WebviewDownloadPayload) => ipcRenderer.invoke("downloads:from-url", payload) as Promise<boolean>,
  sendTelemetry: (payload: WebviewTelemetryPayload) => ipcRenderer.send("webview:telemetry", payload),
  onDownloadChanged: (callback: (payload: DownloadUpdatePayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DownloadUpdatePayload) => callback(payload);
    ipcRenderer.on("downloads:changed", listener);
    return () => ipcRenderer.removeListener("downloads:changed", listener);
  },
  onWebviewTelemetry: (callback: (payload: WebviewTelemetryPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WebviewTelemetryPayload) => callback(payload);
    ipcRenderer.on("webview:telemetry", listener);
    return () => ipcRenderer.removeListener("webview:telemetry", listener);
  },
  onQrChanged: (_callback: (payload: WebviewQrPayload) => void) => () => undefined
};

contextBridge.exposeInMainWorld("wechatDock", api);

declare global {
  interface Window {
    wechatDock: typeof api;
  }
}
