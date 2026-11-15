/**
 * AWS Signature Version 4 for one SES v2 request (TDD §7.6), on WebCrypto. Small enough not to need a
 * dependency (AGENTS §4.4). Signs `content-type`, `host` and `x-amz-date` and the SHA-256 of the body.
 */

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  if (key instanceof Uint8Array) key = new Uint8Array(key).buffer;
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}

/** The SigV4 signing key: HMAC chain over date, region, service and `aws4_request`. */
export async function signingKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export { hex as toHex };

/** `20261115T120000Z` and `20261115` for an epoch-ms time. */
export function amzDates(now: number): { amzDate: string; date: string } {
  const iso = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate: iso, date: iso.slice(0, 8) };
}

export interface SesSignInput {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  host: string;
  path: string;
  body: string;
  now: number;
}

/** The headers for a signed `POST` to SES v2. */
export async function sesSignedHeaders(input: SesSignInput): Promise<Record<string, string>> {
  const service = "ses";
  const { amzDate, date } = amzDates(input.now);
  const contentType = "application/json";
  const payloadHash = await sha256Hex(input.body);
  const canonicalHeaders = `content-type:${contentType}\nhost:${input.host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = ["POST", input.path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const key = await signingKey(input.secretAccessKey, date, input.region, service);
  const signature = hex(await hmac(key, stringToSign));
  return {
    "Content-Type": contentType,
    "X-Amz-Date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
