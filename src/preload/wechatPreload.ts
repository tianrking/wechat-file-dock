import { ipcRenderer } from "electron";
import type {
  DownloadRules,
  TransferKind,
  WebviewDownloadPayload,
  WebviewQrPayload,
  WebviewSettingsPayload,
  WebviewTelemetryPayload
} from "../shared/types";

type BaseRequest = {
  Uin: number | string;
  Sid: string;
  Skey: string;
  DeviceID: string;
};

type RuntimeState = {
  baseRequest?: BaseRequest;
  userName?: string;
  passTicket?: string;
  sendEndpoint?: string;
};

let accountId = "";
let autoDownload = true;
let rules: DownloadRules = {
  document: true,
  image: true,
  video: true,
  audio: true,
  archive: true,
  code: true,
  app: true,
  other: true
};
let scanTimer: number | null = null;
let lastLoginState = "";
let lastQrSrc = "";

const runtime: RuntimeState = {};
const clickedNodes = new WeakSet<Element>();
const sentUrls = new Map<string, number>();

const documentExtensionPattern = /\.(csv|docx?|key|numbers|pages|pdf|pptx?|rtf|txt|xlsx?)(?:$|[?#&])/i;
const imageExtensionPattern = /\.(avif|bmp|gif|heic|jpe?g|png|svg|tiff?|webp)(?:$|[?#&])/i;
const videoExtensionPattern = /\.(avi|flv|m4v|mkv|mov|mp4|mpeg|mpg|webm|wmv)(?:$|[?#&])/i;
const audioExtensionPattern = /\.(aac|aiff?|flac|m4a|mp3|ogg|opus|wav|wma)(?:$|[?#&])/i;
const archiveExtensionPattern = /\.(7z|bz2|gz|iso|rar|tar|tgz|xz|zip)(?:$|[?#&])/i;
const codeExtensionPattern = /\.(c|cc|cpp|cs|css|go|h|hpp|html?|java|js|json|jsx|kt|log|lua|md|php|py|rs|sh|sql|swift|toml|ts|tsx|xml|yaml|yml)(?:$|[?#&])/i;
const appExtensionPattern = /\.(apk|appx|bin|deb|dmg|exe|ipa|msi|pkg|rpm|ufw)(?:$|[?#&])/i;
const anyKnownExtensionPattern = /\.(7z|aac|apk|appx|avi|bin|bmp|bz2|c|cc|cpp|cs|csv|css|deb|dmg|docx?|exe|flac|gif|go|gz|heic|html?|ipa|iso|java|jpe?g|js|json|jsx|key|kt|log|m4a|m4v|md|mkv|mov|mp3|mp4|msi|ogg|opus|pages|pdf|php|pkg|png|pptx?|py|rar|rpm|rs|rtf|sh|sql|svg|swift|tar|tgz|tiff?|toml|ts|tsx|txt|ufw|wav|webm|webp|wma|xlsx?|xml|xz|yaml|yml|zip)(?:$|[?#&])/i;
const mediaEndpointPattern = /webwxgetmsgimg|webwxgetvideo|webwxgetmedia|getmsgimg|getvideo|getmedia|download|attachment/i;
const fileHelperMediaPathPattern = /\/cgi-bin\/mmwebwx-bin\/webwxget(?:msgimg|video|media)/i;
const internalWeChatShellPathPattern = /\/(?:feedback(?:\.html?)?|filehelper(?:\.weixin)?|szfilehelper(?:\.weixin)?)?$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sendTelemetry(payload: Omit<WebviewTelemetryPayload, "accountId">): void {
  ipcRenderer.sendToHost("wfd:telemetry", { accountId, ...payload });
}

function getCookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function randomDeviceId(): string {
  return `e${Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join("")}`;
}

function mergeRuntimeFromPayload(payload: unknown): void {
  const record = asRecord(payload);
  if (!record) {
    return;
  }

  const base = asRecord(record.BaseRequest);
  if (base) {
    runtime.baseRequest = {
      Uin: String(base.Uin ?? ""),
      Sid: String(base.Sid ?? ""),
      Skey: String(base.Skey ?? ""),
      DeviceID: String(base.DeviceID ?? randomDeviceId())
    };
  }

  const msg = asRecord(record.Msg);
  if (msg?.FromUserName) {
    runtime.userName = String(msg.FromUserName);
  }
}

function mergeRuntimeFromResponse(payload: unknown): void {
  const record = asRecord(payload);
  if (!record) {
    return;
  }

  const user = asRecord(record.User);
  if (user?.UserName) {
    runtime.userName = String(user.UserName);
  }

  if (record.pass_ticket) {
    runtime.passTicket = String(record.pass_ticket);
  }
}

function mergeRuntimeFromUrl(rawUrl: string): void {
  try {
    const url = new URL(rawUrl, window.location.href);
    const passTicket = url.searchParams.get("pass_ticket");
    if (passTicket) {
      runtime.passTicket = passTicket;
    }

    if (/webwxsendmsg/i.test(url.pathname)) {
      runtime.sendEndpoint = url.toString();
    }
  } catch {
    // Ignore malformed partial URLs.
  }
}

function isLogoutUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, window.location.href);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const isWeChatHost = /(^|\.)qq\.com$/.test(hostname) || /(^|\.)wechat\.com$/.test(hostname) || /(^|\.)weixin\.qq\.com$/.test(hostname);
    return isWeChatHost && (path.includes("webwxlogout") || path.endsWith("/logout") || path.includes("/logout/"));
  } catch {
    return /webwxlogout/i.test(rawUrl);
  }
}

function reportBlockedLogout(channel: string, rawUrl: string): void {
  sendTelemetry({
    kind: "session-preserved",
    message: `Blocked WeChat logout through ${channel}`,
    details: { url: rawUrl.slice(0, 180) }
  });
}

function bootstrapRuntimeFromStorage(): void {
  const wxuin = getCookie("wxuin");
  const wxsid = getCookie("wxsid");
  const skey = getCookie("skey") ?? "";

  if (!runtime.baseRequest && wxuin && wxsid) {
    runtime.baseRequest = {
      Uin: wxuin,
      Sid: wxsid,
      Skey: skey,
      DeviceID: randomDeviceId()
    };
  }

  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) {
        continue;
      }

      const parsed = parseMaybeJson(storage.getItem(key));
      mergeRuntimeFromPayload(parsed);
      mergeRuntimeFromResponse(parsed);
    }
  }
}

function installNetworkCapture(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method: string, url: string | URL, ...rest: unknown[]) {
    const rawUrl = String(url);
    (this as XMLHttpRequest & { __wfdUrl?: string }).__wfdUrl = rawUrl;
    mergeRuntimeFromUrl(rawUrl);
    return originalOpen.apply(this, [method, url, ...rest] as never);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest & { __wfdUrl?: string };
    const rawUrl = xhr.__wfdUrl ?? "";
    mergeRuntimeFromPayload(parseMaybeJson(typeof body === "string" ? body : ""));

    if (isLogoutUrl(rawUrl)) {
      reportBlockedLogout("XHR", rawUrl);
      try {
        xhr.abort();
      } catch {
        // Ignore abort failures during page unload.
      }
      return;
    }

    xhr.addEventListener("loadend", () => {
      if (/webwxinit|webwxsendmsg|webwxsync/i.test(rawUrl)) {
        mergeRuntimeFromUrl(rawUrl);
        mergeRuntimeFromResponse(parseMaybeJson(xhr.responseText));
      }
    });

    return originalSend.call(this, body);
  };

  if (window.fetch) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      mergeRuntimeFromUrl(rawUrl);
      mergeRuntimeFromPayload(parseMaybeJson(typeof init?.body === "string" ? init.body : ""));

      if (isLogoutUrl(rawUrl)) {
        reportBlockedLogout("fetch", rawUrl);
        return new Response(null, { status: 204, statusText: "Blocked by WeChat File Dock" });
      }

      const response = await originalFetch(input, init);

      if (/webwxinit|webwxsendmsg|webwxsync/i.test(rawUrl)) {
        response
          .clone()
          .text()
          .then((text) => mergeRuntimeFromResponse(parseMaybeJson(text)))
          .catch(() => undefined);
      }

      return response;
    };
  }

  const originalBeacon = navigator.sendBeacon?.bind(navigator);
  if (originalBeacon) {
    const patchedBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
      const rawUrl = String(url);
      if (isLogoutUrl(rawUrl)) {
        reportBlockedLogout("sendBeacon", rawUrl);
        return true;
      }

      return originalBeacon(url, data);
    };

    try {
      Object.defineProperty(navigator, "sendBeacon", {
        configurable: true,
        writable: true,
        value: patchedBeacon
      });
    } catch {
      (navigator as Navigator & { sendBeacon: typeof patchedBeacon }).sendBeacon = patchedBeacon;
    }
  }
}

function absoluteUrl(raw: string): string | null {
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
    return null;
  }

  try {
    return new URL(raw, window.location.href).toString();
  } catch {
    return null;
  }
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, window.location.href);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/skey|sid|uin|ticket|token|pass/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return rawUrl.replace(/([?&](?:skey|sid|uin|ticket|token|pass_ticket)=)[^&\s]+/gi, "$1[redacted]");
  }
}

function isInternalWeChatShellUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, window.location.href);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();

    if (pathname.endsWith(".weixin")) {
      return true;
    }

    if (hostname === "filehelper.weixin.qq.com" && !fileHelperMediaPathPattern.test(pathname)) {
      return true;
    }

    return internalWeChatShellPathPattern.test(pathname) && /filehelper|feedback/i.test(pathname);
  } catch {
    return /\.weixin(?:$|[?#])|feedback\.html?/i.test(rawUrl);
  }
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden";
}

function textOf(element: Element): string {
  return [
    element.textContent ?? "",
    element.getAttribute("title") ?? "",
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("alt") ?? "",
    element.getAttribute("download") ?? "",
    element.getAttribute("href") ?? "",
    element.getAttribute("src") ?? "",
    element.getAttribute("class") ?? ""
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function contextText(element: Element): string {
  const chunks: string[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 6; depth += 1) {
    chunks.push(textOf(current));
    current = current.parentElement;
  }
  return chunks.join(" ").replace(/\s+/g, " ");
}

function filenameFromText(value: string, kind: TransferKind): string | undefined {
  const match = value.match(/[^\s"'<>\\/|:*?]+?\.[a-z0-9]{1,8}\b/i);
  if (match?.[0]) {
    return match[0];
  }

  if (kind === "image") {
    return `wechat-image-${Date.now()}.jpg`;
  }
  if (kind === "video") {
    return `wechat-video-${Date.now()}.mp4`;
  }
  if (kind === "audio") {
    return `wechat-audio-${Date.now()}.mp3`;
  }
  return undefined;
}

function classify(value: string, fallback: TransferKind | null = null): TransferKind | null {
  if (videoExtensionPattern.test(value) || /video|mp4|webwxgetvideo|getvideo/i.test(value)) {
    return "video";
  }

  if (audioExtensionPattern.test(value) || /audio|voice|mp3|wav/i.test(value)) {
    return "audio";
  }

  if (imageExtensionPattern.test(value) || /image|photo|webwxgetmsgimg|getmsgimg/i.test(value)) {
    return "image";
  }

  if (archiveExtensionPattern.test(value)) {
    return "archive";
  }

  if (appExtensionPattern.test(value)) {
    return "app";
  }

  if (codeExtensionPattern.test(value)) {
    return "code";
  }

  if (documentExtensionPattern.test(value)) {
    return "document";
  }

  if (anyKnownExtensionPattern.test(value) || /file|attachment|webwxgetmedia|getmedia|download/i.test(value)) {
    return "other";
  }

  return fallback;
}

function candidateUrlFromElement(element: Element): string | null {
  const raw =
    element.getAttribute("href") ??
    element.getAttribute("src") ??
    element.getAttribute("data-src") ??
    element.getAttribute("data-url") ??
    element.getAttribute("data-href") ??
    "";
  return absoluteUrl(raw);
}

function sendDownload(payload: Omit<WebviewDownloadPayload, "accountId">): void {
  const key = `${payload.kind}:${payload.url}`;
  const now = Date.now();
  const last = sentUrls.get(key) ?? 0;
  if (now - last < 90_000) {
    return;
  }

  sentUrls.set(key, now);
  for (const [entry, timestamp] of sentUrls.entries()) {
    if (now - timestamp > 180_000) {
      sentUrls.delete(entry);
    }
  }

  ipcRenderer.sendToHost("wfd:download-url", { accountId, ...payload } satisfies WebviewDownloadPayload);
  sendTelemetry({
    kind: "download-url",
    message: `queued ${payload.kind}`,
    details: { filename: payload.filename, url: redactUrl(payload.url).slice(0, 160) }
  });
}

function isDownloadableCandidate(url: string, text: string, node: Element): boolean {
  if (isInternalWeChatShellUrl(url)) {
    return false;
  }

  if (node instanceof HTMLAnchorElement && node.hasAttribute("download")) {
    return true;
  }

  return mediaEndpointPattern.test(url) || anyKnownExtensionPattern.test(text);
}

function collectUrlsFromContext(element: Element): Array<{ url: string; kind: TransferKind; filename?: string }> {
  const root = element.closest("[class*='message'], [class*='msg'], [class*='bubble'], [class*='file'], li, .chat_item") ?? element;
  const nodes = Array.from(root.querySelectorAll("a[href], img[src], video[src], source[src], [data-src], [data-url], [data-href]"));
  const results: Array<{ url: string; kind: TransferKind; filename?: string }> = [];

  for (const node of nodes) {
    const url = candidateUrlFromElement(node);
    if (!url) {
      continue;
    }

    const text = `${contextText(node)} ${url}`;
    const rect = node.getBoundingClientRect();
    const fallback = node instanceof HTMLImageElement && rect.width >= 48 && rect.height >= 48 ? "image" : null;
    const kind = classify(text, fallback);
    if (!kind || !rules[kind]) {
      continue;
    }

    if (!isDownloadableCandidate(url, text, node)) {
      continue;
    }

    results.push({ url, kind, filename: filenameFromText(text, kind) });
  }

  return results;
}

function looksLikeDownloadControl(element: Element): boolean {
  if (!visible(element) || clickedNodes.has(element)) {
    return false;
  }

  const value = contextText(element);
  if (/logout|login|scan|refresh|cancel|close|退出|登录|扫码|刷新|取消|关闭/i.test(value)) {
    return false;
  }

  if (element instanceof HTMLAnchorElement && (element.hasAttribute("download") || mediaEndpointPattern.test(element.href))) {
    return true;
  }

  return /download|down|save|\u4e0b\u8f7d|\u4fdd\u5b58|icon_down/i.test(`${value} ${element.getAttribute("class") ?? ""}`);
}

function scanDownloadControls(): void {
  const selector = [
    "a[download]",
    "a[href*='download']",
    "a[href*='getmedia']",
    "a[href*='getmsgimg']",
    "a[href*='getvideo']",
    "button",
    "[role='button']",
    "[class*='download']",
    "[class*='down']",
    "[class*='save']",
    "[title]",
    "[aria-label]"
  ].join(",");

  for (const control of Array.from(document.querySelectorAll(selector))) {
    if (!looksLikeDownloadControl(control)) {
      continue;
    }

    const entries = collectUrlsFromContext(control);
    if (entries.length === 0) {
      continue;
    }

    for (const entry of entries) {
      sendDownload({ ...entry, sourceText: contextText(control).slice(0, 240) });
    }

    clickedNodes.add(control);
    sendTelemetry({
      kind: "download-url",
      message: "detected page download control",
      details: { text: textOf(control).slice(0, 160), count: entries.length }
    });
  }
}

function scanInlineMedia(): void {
  const nodes = Array.from(document.querySelectorAll("a[href], img[src], video[src], source[src]"));
  for (const node of nodes) {
    if (!visible(node)) {
      continue;
    }

    const url = candidateUrlFromElement(node);
    if (!url) {
      continue;
    }

    const text = `${contextText(node)} ${url}`;
    const rect = node.getBoundingClientRect();
    const fallback = node instanceof HTMLImageElement && rect.width >= 72 && rect.height >= 72 ? "image" : null;
    const kind = classify(text, fallback);
    if (!kind || !rules[kind]) {
      continue;
    }

    if (!isDownloadableCandidate(url, text, node)) {
      continue;
    }

    sendDownload({ url, kind, filename: filenameFromText(text, kind), sourceText: text.slice(0, 240) });
  }
}

function scanForDownloads(): void {
  if (!autoDownload || !accountId) {
    return;
  }

  try {
    scanDownloadControls();
    scanInlineMedia();
  } catch (error) {
    sendTelemetry({ kind: "scan-error", message: error instanceof Error ? error.message : String(error) });
  }
}

function sendQr(src: string): void {
  if (!src || src === lastQrSrc) {
    return;
  }

  lastQrSrc = src;
  ipcRenderer.sendToHost("wfd:qr", { accountId, src, detectedAt: new Date().toISOString() } satisfies WebviewQrPayload);
}

function detectQrCode(): void {
  for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) {
      continue;
    }

    try {
      const dataUrl = canvas.toDataURL("image/png");
      if (dataUrl.startsWith("data:image/png")) {
        sendQr(dataUrl);
        return;
      }
    } catch {
      // Tainted canvas, try image fallback.
    }
  }

  const image = Array.from(document.querySelectorAll<HTMLImageElement>("img[src]")).find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 80 && /qr|qrcode|login|scan|二维码|扫码/i.test(textOf(candidate));
  });
  const src = image ? absoluteUrl(image.getAttribute("src") ?? "") : null;
  if (src) {
    sendQr(src);
  }
}

function detectLoginState(): void {
  const bodyText = document.body?.innerText ?? "";
  const hasQr = Boolean(document.querySelector("canvas, img[src*='qrcode'], img[src*='login']"));
  const wantsScan = /扫码|二维码|scan|log in|login/i.test(bodyText);
  const state = hasQr && wantsScan ? "login-required" : "online";

  if (state === "login-required") {
    detectQrCode();
  }

  if (state === lastLoginState) {
    return;
  }

  lastLoginState = state;
  sendTelemetry({
    kind: state,
    message: state === "login-required" ? "WeChat login is required" : "WeChat page is online"
  });
}

function scheduleScan(): void {
  if (scanTimer !== null) {
    window.clearTimeout(scanTimer);
  }

  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    bootstrapRuntimeFromStorage();
    detectLoginState();
    scanForDownloads();
  }, 500);
}

function insertText(target: HTMLElement, text: string): void {
  target.focus();

  const selection = window.getSelection();
  if (target.isContentEditable && selection) {
    document.execCommand("insertText", false, text);
  } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
    target.setSelectionRange(start + text.length, start + text.length);
  }

  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

function findComposer(): HTMLElement | null {
  const selectors = [
    "textarea",
    "input[type='text']",
    "[contenteditable='true']",
    "[role='textbox']",
    "[class*='input']",
    "[class*='edit']"
  ].join(",");
  return Array.from(document.querySelectorAll<HTMLElement>(selectors))
    .reverse()
    .find((element) => visible(element) && !element.hasAttribute("disabled")) ?? null;
}

function findSendButton(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], a"))
    .reverse()
    .find((element) => visible(element) && /^(send|发送)$/i.test(textOf(element).trim()) && !element.hasAttribute("disabled")) ?? null;
}

function resolveSendEndpoint(): string | null {
  if (runtime.sendEndpoint) {
    return runtime.sendEndpoint;
  }

  const url = new URL("/cgi-bin/mmwebwx-bin/webwxsendmsg", window.location.origin);
  if (runtime.passTicket) {
    url.searchParams.set("pass_ticket", runtime.passTicket);
  }
  return url.toString();
}

function normalizeTextContent(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeClientMessageId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0")}`;
}

async function sendTextViaApi(text: string): Promise<boolean> {
  bootstrapRuntimeFromStorage();

  const endpoint = resolveSendEndpoint();
  if (!endpoint || !runtime.baseRequest || !runtime.userName) {
    return false;
  }

  const clientMsgId = makeClientMessageId();
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      BaseRequest: runtime.baseRequest,
      Msg: {
        Type: 1,
        Content: normalizeTextContent(text),
        FromUserName: runtime.userName,
        ToUserName: "filehelper",
        LocalID: clientMsgId,
        ClientMsgId: clientMsgId
      },
      Scene: 0
    })
  });

  const result = (await response.json()) as { BaseResponse?: { Ret?: number; ErrMsg?: string } };
  const ret = result.BaseResponse?.Ret;
  if (ret === 0) {
    sendTelemetry({
      kind: "text-send-result",
      message: "Text sent through hidden WeChat web session",
      details: { method: "webwxsendmsg", clientMsgId }
    });
    return true;
  }

  throw new Error(result.BaseResponse?.ErrMsg || `webwxsendmsg returned ${String(ret)}`);
}

async function sendTextViaDom(text: string): Promise<boolean> {
  const composer = findComposer();
  if (!composer) {
    return false;
  }

  insertText(composer, text);
  const button = findSendButton();
  if (button) {
    button.click();
    sendTelemetry({ kind: "text-send-result", message: "Text sent through hidden DOM fallback", details: { method: "dom-button" } });
    return true;
  }

  composer.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    })
  );
  sendTelemetry({ kind: "text-send-result", message: "Text submitted through hidden DOM fallback", details: { method: "dom-enter" } });
  return true;
}

ipcRenderer.on("wfd:settings", (_event, payload: WebviewSettingsPayload) => {
  accountId = payload.accountId;
  autoDownload = payload.autoDownload;
  rules = payload.rules;
  scheduleScan();
});

ipcRenderer.on("wfd:send-text", async (_event, text: string) => {
  const content = text.trim();
  if (!content) {
    return;
  }

  sendTelemetry({ kind: "text-send-result", message: "Sending text through hidden WeChat session", details: { method: "start" } });

  try {
    if (await sendTextViaApi(content)) {
      return;
    }

    if (await sendTextViaDom(content)) {
      return;
    }

    sendTelemetry({
      kind: "text-send-result",
      message: "Text send failed: WeChat send channel was not ready",
      details: { method: "none" }
    });
  } catch (error) {
    sendTelemetry({
      kind: "text-send-result",
      message: `Text send failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { method: "error" }
    });
  }
});

installNetworkCapture();
bootstrapRuntimeFromStorage();

window.addEventListener("DOMContentLoaded", () => {
  bootstrapRuntimeFromStorage();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["title", "aria-label", "href", "src", "class", "data-src", "data-url", "data-href"]
  });

  scheduleScan();
  window.setInterval(scheduleScan, 4000);
});
