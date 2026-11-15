/**
 * Device details for "My devices" (Identity §4.5): a readable label such as "Chrome on macOS" from the
 * User-Agent, and an approximate location from Cloudflare's `request.cf` (city and country). Both are
 * stored with the session and deleted with it. Neither is ever logged.
 *
 * A short hand-written parser rather than a dependency (AGENTS §4.4): only the common browsers and
 * systems are named; anything else gets no label.
 */

export interface DeviceInfo {
  userAgent: string | null;
  deviceLabel: string | null;
  approxLocation: string | null;
}

const MAX_USER_AGENT = 512;

function browserOf(ua: string): string | null {
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\b(?:OPR|Opera)\//.test(ua)) return "Opera";
  if (/\b(?:Firefox|FxiOS)\//.test(ua)) return "Firefox";
  if (/\bSamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(ua)) return "Chrome";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return "Safari";
  return null;
}

function systemOf(ua: string): string | null {
  if (/\biPad\b/.test(ua)) return "iPadOS";
  if (/\b(?:iPhone|iPod)\b/.test(ua)) return "iOS";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bLinux\b/.test(ua)) return "Linux";
  return null;
}

export function deviceLabel(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const browser = browserOf(userAgent);
  const system = systemOf(userAgent);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system;
}

interface CfLocation {
  city?: unknown;
  country?: unknown;
}

export function approxLocation(cf: CfLocation | undefined): string | null {
  const city = typeof cf?.city === "string" && cf.city !== "" ? cf.city : null;
  const country = typeof cf?.country === "string" && cf.country !== "" && cf.country !== "XX" ? cf.country : null;
  const parts = [city, country].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(", ").slice(0, 120) : null;
}

export function deviceInfo(request: Request): DeviceInfo {
  const ua = request.headers.get("User-Agent");
  const userAgent = ua ? ua.slice(0, MAX_USER_AGENT) : null;
  return {
    userAgent,
    deviceLabel: deviceLabel(userAgent),
    approxLocation: approxLocation(request.cf as CfLocation | undefined),
  };
}

/** The client's IP for per-IP rate limits. Cloudflare sets this header and overwrites any sent by the client. */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
