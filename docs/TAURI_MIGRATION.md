# Tauri Migration

This branch migrates WeChat File Dock toward a Tauri v2 desktop shell while keeping the stable Electron implementation on `main`.

## Goals

- Keep the existing React product UI.
- Move desktop state, settings, dialogs, path opening, packaging, and long-running services to Rust.
- Replace Electron webview partitions with a Tauri-managed WeChat session engine only after cookie persistence, QR extraction, download capture, and multi-account isolation are verified on Windows, macOS, and Linux.

## Current Status

- Tauri v2 app shell is scaffolded in `src-tauri`.
- React can run against either the Electron preload API or the Tauri command API.
- Rust implements local state persistence, account CRUD, settings updates, folder selection, path opening, and event emission.
- Electron's hidden `<webview>` engine is disabled at runtime inside Tauri to avoid false behavior.

## Not Yet Migrated

- Hidden WeChat session windows.
- QR extraction from the official WeChat page.
- Per-account cookie/session isolation.
- Automatic download capture with authenticated WeChat cookies.
- Text sending through the hidden WeChat web session.
- Release workflow for Tauri artifacts.

## Verification Commands

```powershell
npm run typecheck
cd src-tauri
cargo check
cd ..
npm run build:tauri
```

## Migration Order

1. Create a Rust `wechat_engine` module that owns one hidden Tauri webview per account.
2. Prove persistent cookies survive app restart on all target platforms.
3. Port the injected WeChat detector from `src/preload/wechatPreload.ts` to the Tauri webview initialization path.
4. Move download filtering and file writes into Rust so the UI only receives trusted records.
5. Add Tauri release jobs beside the existing Electron release workflow.
