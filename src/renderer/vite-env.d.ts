/// <reference types="vite/client" />

import type {
  AccountProfile,
  AppSettings,
  BootstrapPayload,
  DownloadUpdatePayload,
  WebviewDownloadPayload,
  WebviewQrPayload,
  WebviewTelemetryPayload
} from "../shared/types";

type DockApi = {
  bootstrap: () => Promise<BootstrapPayload>;
  createAccount: (name: string) => Promise<AccountProfile>;
  updateAccount: (accountId: string, patch: Partial<Pick<AccountProfile, "name" | "enabled">>) => Promise<AccountProfile[]>;
  clearAccountSession: (accountId: string) => Promise<boolean>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  chooseDownloadDir: () => Promise<string | null>;
  openPath: (targetPath: string) => Promise<string>;
  downloadFromUrl: (payload: WebviewDownloadPayload) => Promise<boolean>;
  sendText?: (accountId: string, text: string) => Promise<boolean>;
  sendTelemetry: (payload: WebviewTelemetryPayload) => void;
  onDownloadChanged: (callback: (payload: DownloadUpdatePayload) => void) => () => void;
  onWebviewTelemetry: (callback: (payload: WebviewTelemetryPayload) => void) => () => void;
  onQrChanged: (callback: (payload: WebviewQrPayload) => void) => () => void;
};

declare global {
  interface Window {
    wechatDock: DockApi;
    __TAURI_INTERNALS__?: unknown;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        allowpopups?: string;
        partition?: string;
        preload?: string;
        src?: string;
        webpreferences?: string;
      };
    }
  }
}
