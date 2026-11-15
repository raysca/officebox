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

/**
 * The client's IP for per-IP rate limits. Cloudflare always sets `CF-Connecting-IP` on requests that
 * reach a deployed Worker, overwriting any value the client sent; "unknown" only happens locally
 * (tests, `wrangler dev` without the header), where every request then shares one bucket.
 */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/** Expands an IPv6 address to eight 4-digit groups, or returns null when it isn't one. */
function expandIpv6(ip: string): string[] | null {
  if (!ip.includes(":")) return null;
  let address = ip.split("%")[0] ?? ip;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    address = `${address.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => g.toLowerCase().padStart(4, "0"));
}

/**
 * The bucket a client IP counts in for per-IP throttles: the address itself for IPv4, its /64 for
 * IPv6 (one customer usually holds a whole /64, so per-address limits would be trivial to dodge).
 */
export function ipBucket(ip: string): string {
  // An IPv4-mapped address is that IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  // ::ffff:0102:0304, the hex spelling of an IPv4-mapped address, is 1.2.3.4 too.
  if (groups.slice(0, 5).every((g) => g === "0000") && groups[5] === "ffff") {
    const [hi = 0, lo = 0] = [parseInt(groups[6] ?? "0", 16), parseInt(groups[7] ?? "0", 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}
