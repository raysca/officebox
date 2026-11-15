import { describe, expect, it } from "vitest";
import { cloudflareDriver, cloudflareOutcome } from "../../src/features/email/drivers/cloudflare";
import { postmarkDriver, resendDriver, sesDriver } from "../../src/features/email/drivers/http";
import { signingKey, toHex } from "../../src/features/email/drivers/sigv4";
import { buildMime, sendSmtp, type SmtpConnect, type SmtpSocket } from "../../src/features/email/drivers/smtp";
import { sinkAllowed } from "../../src/features/email/drivers/sink";
import type { Fetch, OutgoingEmail } from "../../src/features/email/drivers/types";
import { escapeHtml, invitationEmail } from "../../src/features/email/templates";

/**
 * Email drivers' error mapping (TDD §7.6). No real mail is sent: HTTP providers get a fake `fetch`,
 * SMTP a scripted socket, Cloudflare a fake binding.
 */

const EMAIL: OutgoingEmail = {
  id: "01JOBIDJOBIDJOBIDJOBIDJOBI",
  to: "ana@example.com",
  from: { email: "no-reply@example.com", name: "Acme Studio" },
  subject: "Hello",
  text: "Plain body",
  html: "<p>HTML body</p>",
};

function fakeFetch(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }),
    );
  };
  return { fetcher, calls };
}

const throwingFetch: Fetch = () => Promise.reject(new TypeError("network down"));

describe("Cloudflare Email Service driver", () => {
  it("sends through the binding's structured send and keeps the message ID", async () => {
    const sent: unknown[] = [];
    const binding = {
      send: (message: unknown) => {
        sent.push(message);
        return Promise.resolve({ messageId: "cf-123" });
      },
    } as unknown as SendEmail;
    expect(await cloudflareDriver(binding).send(EMAIL)).toEqual({ kind: "sent", messageId: "cf-123" });
    expect(sent[0]).toMatchObject({
      from: { email: "no-reply@example.com", name: "Acme Studio" },
      to: "ana@example.com",
      subject: "Hello",
      text: "Plain body",
      html: "<p>HTML body</p>",
    });
  });

  it.each([
    ["E_RATE_LIMIT_EXCEEDED", "transient"],
    ["E_DAILY_LIMIT_EXCEEDED", "transient"],
    ["E_DELIVERY_FAILED", "transient"],
    ["E_INTERNAL_SERVER_ERROR", "transient"],
    ["E_SENDER_NOT_VERIFIED", "permanent"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", "permanent"],
    ["E_RECIPIENT_SUPPRESSED", "permanent"],
    ["E_VALIDATION_ERROR", "permanent"],
    ["E_SOMETHING_NEW", "permanent"],
  ])("maps %s to %s", async (code, kind) => {
    const binding = {
      send: () => Promise.reject(Object.assign(new Error("refused"), { code })),
    } as unknown as SendEmail;
    expect(await cloudflareDriver(binding).send(EMAIL)).toEqual({ kind, code });
  });

  it("an error without a code is a transient network failure", () => {
    expect(cloudflareOutcome(new Error("socket hang up"))).toEqual({ kind: "transient", code: "network" });
  });
});

describe("HTTP providers (Resend, Postmark, SES)", () => {
  it("Resend: sends with the idempotency key; maps 429/5xx to transient and other 4xx to permanent", async () => {
    const ok = fakeFetch(200, { id: "re_1" });
    expect(await resendDriver("re_key", ok.fetcher).send(EMAIL)).toEqual({ kind: "sent", messageId: "re_1" });
    const headers = ok.calls[0]!.init.headers as Record<string, string>;
    expect(ok.calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(headers["Idempotency-Key"]).toBe(EMAIL.id);
    expect(headers.Authorization).toBe("Bearer re_key");
    expect(JSON.parse(ok.calls[0]!.init.body as string)).toMatchObject({
      from: '"Acme Studio" <no-reply@example.com>',
      to: ["ana@example.com"],
    });

    expect((await resendDriver("k", fakeFetch(429, { name: "rate_limit_exceeded" }).fetcher).send(EMAIL)).kind).toBe(
      "transient",
    );
    expect((await resendDriver("k", fakeFetch(503).fetcher).send(EMAIL)).kind).toBe("transient");
    expect(await resendDriver("k", fakeFetch(422, { name: "validation_error" }).fetcher).send(EMAIL)).toEqual({
      kind: "permanent",
      code: "http_422:validation_error",
    });
    expect((await resendDriver("k", fakeFetch(401).fetcher).send(EMAIL)).kind).toBe("permanent");
    expect(await resendDriver("k", throwingFetch).send(EMAIL)).toEqual({ kind: "transient", code: "network" });
  });

  it("Postmark: sends with the server token; maps errors the same way", async () => {
    const ok = fakeFetch(200, { ErrorCode: 0, MessageID: "pm-1" });
    expect(await postmarkDriver("pm_token", ok.fetcher).send(EMAIL)).toEqual({ kind: "sent", messageId: "pm-1" });
    expect((ok.calls[0]!.init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("pm_token");
    expect(await postmarkDriver("t", fakeFetch(422, { ErrorCode: 406 }).fetcher).send(EMAIL)).toEqual({
      kind: "permanent",
      code: "http_422:406",
    });
    expect((await postmarkDriver("t", fakeFetch(500).fetcher).send(EMAIL)).kind).toBe("transient");
    expect((await postmarkDriver("t", throwingFetch).send(EMAIL)).kind).toBe("transient");
  });

  it("SES: signs with SigV4 for the region; maps the x-amzn-ErrorType", async () => {
    const ok = fakeFetch(200, { MessageId: "ses-1" });
    const driver = sesDriver(
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", region: "eu-west-1" },
      ok.fetcher,
      () => Date.UTC(2026, 10, 15, 12, 0, 0),
    );
    expect(await driver.send(EMAIL)).toEqual({ kind: "sent", messageId: "ses-1" });
    expect(ok.calls[0]!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    const headers = ok.calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Amz-Date"]).toBe("20261115T120000Z");
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261115\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    const throttled = sesDriver(
      { accessKeyId: "a", secretAccessKey: "b", region: "eu-west-1" },
      fakeFetch(429, {}, { "x-amzn-ErrorType": "TooManyRequestsException:http://internal" }).fetcher,
    );
    expect(await throttled.send(EMAIL)).toEqual({ kind: "transient", code: "http_429:TooManyRequestsException" });
    const rejected = sesDriver(
      { accessKeyId: "a", secretAccessKey: "b", region: "eu-west-1" },
      fakeFetch(400, {}, { "x-amzn-ErrorType": "MessageRejected" }).fetcher,
    );
    expect(await rejected.send(EMAIL)).toEqual({ kind: "permanent", code: "http_400:MessageRejected" });
    const fiveHundred = sesDriver(
      { accessKeyId: "a", secretAccessKey: "b", region: "eu-west-1" },
      fakeFetch(503).fetcher,
    );
    expect((await fiveHundred.send(EMAIL)).kind).toBe("transient");
  });

  it("the SigV4 signing key matches AWS's published example", async () => {
    // AWS General Reference, "Examples of how to derive a signing key for Signature Version 4".
    const key = await signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
    expect(toHex(key)).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });
});

/** A scripted SMTP server: answers each client line with the next reply. */
function scriptedSmtp(replies: Record<string, string>, greeting = "220 mail.example.com ESMTP\r\n") {
  const written: string[] = [];
  const events: string[] = [];
  const makeSocket = (secure: boolean): SmtpSocket => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        if (!secure) c.enqueue(new TextEncoder().encode(greeting));
      },
    });
    const decoder = new TextDecoder();
    let buffer = "";
    let inData = false;
    const writable = new WritableStream<Uint8Array>({
      write(chunk: Uint8Array) {
        buffer += decoder.decode(chunk);
        let index: number;
        while ((index = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          written.push(line);
          if (inData) {
            if (line === ".") {
              inData = false;
              controller.enqueue(new TextEncoder().encode(replies["."] ?? "250 2.0.0 Ok: queued as ABC123\r\n"));
            }
            continue;
          }
          const verb = line.split(" ")[0]!.toUpperCase();
          const key =
            Object.keys(replies)
              .filter((k) => line.toUpperCase().startsWith(k.toUpperCase()))
              .sort((a, b) => b.length - a.length)[0] ?? verb;
          const reply = replies[key];
          if (verb === "DATA") inData = true;
          if (reply !== undefined) controller.enqueue(new TextEncoder().encode(reply));
        }
      },
    });
    return {
      readable,
      writable,
      startTls() {
        events.push("startTls");
        return makeSocket(true);
      },
      close() {
        events.push("close");
        return Promise.resolve();
      },
    };
  };
  const connect: SmtpConnect = (address, options) => {
    events.push(`connect ${address.hostname}:${address.port} ${options.secureTransport}`);
    return makeSocket(false);
  };
  return { connect, written, events };
}

const SETTINGS = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls" as const,
  username: "user",
  password: "pass",
};
const GOOD_REPLIES = {
  EHLO: "250-mail.example.com\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n",
  STARTTLS: "220 2.0.0 Ready to start TLS\r\n",
  AUTH: "235 2.7.0 Authentication successful\r\n",
  MAIL: "250 2.1.0 Ok\r\n",
  RCPT: "250 2.1.5 Ok\r\n",
  DATA: "354 End data with <CR><LF>.<CR><LF>\r\n",
  QUIT: "221 2.0.0 Bye\r\n",
};

describe("SMTP over STARTTLS or implicit TLS", () => {
  it("upgrades with STARTTLS before authenticating, then sends one message", async () => {
    const server = scriptedSmtp(GOOD_REPLIES);
    const outcome = await sendSmtp(server.connect, SETTINGS, EMAIL, Date.UTC(2026, 10, 15));
    expect(outcome).toEqual({ kind: "sent", messageId: "ABC123" });
    expect(server.events[0]).toBe("connect smtp.example.com:587 starttls");
    expect(server.events).toContain("startTls");
    const authIndex = server.written.findIndex((l) => l.startsWith("AUTH"));
    const tlsIndex = server.written.indexOf("STARTTLS");
    expect(tlsIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(tlsIndex);
    expect(server.written).toContain("MAIL FROM:<no-reply@example.com>");
    expect(server.written).toContain("RCPT TO:<ana@example.com>");
    expect(server.events.at(-1)).toBe("close");
  });

  it("implicit TLS on 465 connects securely and never sends STARTTLS", async () => {
    const server = scriptedSmtp(GOOD_REPLIES);
    const outcome = await sendSmtp(server.connect, { ...SETTINGS, port: 465, security: "tls" }, EMAIL, Date.now());
    expect(outcome.kind).toBe("sent");
    expect(server.events[0]).toBe("connect smtp.example.com:465 on");
    expect(server.written).not.toContain("STARTTLS");
  });

  it("never authenticates without TLS: a server without STARTTLS is a permanent failure", async () => {
    const server = scriptedSmtp({ ...GOOD_REPLIES, EHLO: "250-mail.example.com\r\n250 AUTH PLAIN\r\n" });
    expect(await sendSmtp(server.connect, SETTINGS, EMAIL, Date.now())).toEqual({
      kind: "permanent",
      code: "starttls_unavailable",
    });
    expect(server.written.some((l) => l.startsWith("AUTH"))).toBe(false);
  });

  it("falls back to AUTH LOGIN", async () => {
    const server = scriptedSmtp({
      ...GOOD_REPLIES,
      EHLO: "250-mail.example.com\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n",
      "AUTH LOGIN": "334 VXNlcm5hbWU6\r\n",
      dXNlcg: "334 UGFzc3dvcmQ6\r\n",
      cGFzcw: "235 Ok\r\n",
    });
    expect((await sendSmtp(server.connect, SETTINGS, EMAIL, Date.now())).kind).toBe("sent");
  });

  it("4xx replies are transient, 5xx permanent", async () => {
    const busy = scriptedSmtp({ ...GOOD_REPLIES, RCPT: "451 4.7.1 Try again later\r\n" });
    expect(await sendSmtp(busy.connect, SETTINGS, EMAIL, Date.now())).toEqual({
      kind: "transient",
      code: "smtp_451:rcpt",
    });
    const refused = scriptedSmtp({ ...GOOD_REPLIES, AUTH: "535 5.7.8 Authentication failed\r\n" });
    expect(await sendSmtp(refused.connect, SETTINGS, EMAIL, Date.now())).toEqual({
      kind: "permanent",
      code: "smtp_535:auth",
    });
  });

  it("a connection that fails or closes is transient", async () => {
    const failing: SmtpConnect = () => {
      throw new Error("connect refused");
    };
    expect(await sendSmtp(failing, SETTINGS, EMAIL, Date.now())).toEqual({ kind: "transient", code: "connect" });
    const closes = scriptedSmtp({}, "");
    const closing: SmtpConnect = (a, o) => {
      const socket = closes.connect(a, o);
      void socket.readable.cancel();
      return { ...socket, readable: new ReadableStream({ start: (c) => c.close() }) };
    };
    expect((await sendSmtp(closing, SETTINGS, EMAIL, Date.now())).kind).toBe("transient");
  });

  it("the MIME message is multipart text and HTML, with no header injection", () => {
    const mime = buildMime({ ...EMAIL, subject: "Café ☕" }, Date.UTC(2026, 10, 15));
    expect(mime).toContain("Content-Type: multipart/alternative");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain(`Message-ID: <${EMAIL.id}@example.com>`);
    expect(() => buildMime({ ...EMAIL, subject: "Hi\r\nBcc: victim@example.com" }, 0)).toThrow();
    expect(() => buildMime({ ...EMAIL, to: "a@example.com\r\nRCPT TO:<b@example.com>" }, 0)).toThrow();
  });
});

describe("the test sink and templates", () => {
  it("the sink only works on a loopback canonical origin with the flag set", () => {
    expect(sinkAllowed("1", "http://localhost:8788")).toBe(true);
    expect(sinkAllowed("1", "http://127.0.0.1:8788")).toBe(true);
    expect(sinkAllowed("1", "https://officebox.example.com")).toBe(false);
    expect(sinkAllowed(undefined, "http://localhost:8788")).toBe(false);
    expect(sinkAllowed("true", "http://localhost:8788")).toBe(false);
    expect(sinkAllowed("1", null)).toBe(false);
  });

  it("templates escape every value and keep subjects on one line", () => {
    expect(escapeHtml(`<script>"&'`)).toBe("&lt;script&gt;&quot;&amp;&#39;");
    const rendered = invitationEmail({
      workspace: "Acme <b>\r\nBcc: x",
      inviterName: "<img src=x>",
      email: "ana@example.com",
      link: "https://officebox.test/invitations/accept#t=abc",
      expiresAt: 0,
    });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).not.toContain("<b>");
    expect(rendered.html).toContain("&lt;img src=x&gt;");
  });
});
