import { permanent, sent, transient, type EmailDriver, type OutgoingEmail, type SendOutcome } from "./types";

/**
 * Generic SMTP over a TCP socket from `connect()` (TDD §7.6): STARTTLS on port 587 (or 2525)
 * (`secureTransport: "starttls"`, then `startTls()`), or implicit TLS on port 465, with AUTH PLAIN or
 * LOGIN. Cloudflare blocks outbound port 25, so this always goes through the customer's submission
 * server.
 *
 * A minimal client rather than a dependency (AGENTS §4.4 prefers the platform when the code is small):
 * one message, one recipient, a multipart/alternative body in base64. It **never authenticates over
 * an unencrypted connection**: a STARTTLS server that doesn't offer STARTTLS is a permanent failure.
 *
 * Outcomes: SMTP 4xx replies and connection failures are transient; 5xx replies are permanent.
 */

/** The parts of `cloudflare:sockets`' `Socket` this client uses (tests pass a scripted fake). */
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): SmtpSocket;
  close(): Promise<void>;
}

export type SmtpConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on" | "starttls"; allowHalfOpen: boolean },
) => SmtpSocket;

export interface SmtpSettings {
  host: string;
  port: number;
  security: "starttls" | "tls";
  username: string;
  password: string;
}

const STEP_TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();

class SmtpReplyError extends Error {
  constructor(
    readonly code: number,
    readonly step: string,
  ) {
    super(`SMTP ${step} answered ${code}`);
  }
}

class SmtpProtocolError extends Error {}

interface Reply {
  code: number;
  lines: string[];
}

/** Reads CRLF-terminated replies, including multi-line `250-…` ones, from a socket. */
class ReplyReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async more(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpProtocolError("timeout")), STEP_TIMEOUT_MS);
    });
    try {
      const { done, value } = await Promise.race([this.reader.read(), timeout]);
      if (done) throw new SmtpProtocolError("connection closed");
      this.buffer += this.decoder.decode(value, { stream: true });
      if (this.buffer.length > 64 * 1024) throw new SmtpProtocolError("reply too long");
    } finally {
      clearTimeout(timer);
    }
  }

  async read(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      let index = this.buffer.indexOf("\r\n");
      while (index < 0) {
        await this.more();
        index = this.buffer.indexOf("\r\n");
      }
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) throw new SmtpProtocolError("malformed reply");
      lines.push(match[3] ?? "");
      if (match[2] === " ") return { code: Number(match[1]), lines };
    }
  }

  release(): void {
    this.reader.releaseLock();
  }
}

function base64(text: string): string {
  let binary = "";
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function wrap76(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").replace(/\r\n$/, "");
}

/**
 * RFC 2047 encoded words for a header holding non-ASCII text: each word at most 75 characters (45 bytes
 * of UTF-8 per word, never splitting a character), folded onto continuation lines.
 */
export function encodedWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (encoder.encode(chunk + char).byteLength > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64(word)}?=`).join("\r\n ");
}

function assertHeaderSafe(...values: string[]): void {
  for (const value of values) {
    if (/[\r\n]/.test(value)) throw new SmtpProtocolError("line break in a header value");
  }
}

/** Envelope addresses go inside `<…>` on MAIL FROM and RCPT TO: no brackets, whitespace or controls. */
function assertAddressSafe(...addresses: string[]): void {
  for (const address of addresses) {
    if (!/^[^\s<>\p{Cc}]+@[^\s<>\p{Cc}]+$/u.test(address)) {
      throw new SmtpProtocolError("unsafe envelope address");
    }
  }
}

/** The message as sent after DATA, dot-stuffed and CRLF-terminated (without the final `.`). */
export function buildMime(email: OutgoingEmail, now: number): string {
  assertHeaderSafe(email.to, email.from.email, email.from.name ?? "", email.subject, email.id);
  assertAddressSafe(email.to, email.from.email);
  const boundary = `officebox-${email.id}`;
  const domain = email.from.email.split("@")[1] ?? "localhost";
  const from = email.from.name
    ? `${encodedWord(email.from.name.replace(/["\\]/g, ""))} <${email.from.email}>`
    : email.from.email;
  const lines = [
    `From: ${from}`,
    `To: <${email.to}>`,
    `Subject: ${encodedWord(email.subject)}`,
    `Date: ${new Date(now).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${email.id}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64(email.text)),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64(email.html)),
    `--${boundary}--`,
    "",
  ];
  // Dot-stuffing (RFC 5321 §4.5.2); base64 never starts a line with ".", but headers could.
  return lines.map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
}

function hasCapability(reply: Reply, name: string): boolean {
  return reply.lines.some((line) => line.toUpperCase().split(/\s+/)[0] === name);
}

function authMechanisms(reply: Reply): string[] {
  const line = reply.lines.find((l) => /^AUTH[ =]/i.test(l));
  return line ? line.slice(5).toUpperCase().split(/\s+/) : [];
}

export async function sendSmtp(
  connect: SmtpConnect,
  settings: SmtpSettings,
  email: OutgoingEmail,
  now: number,
): Promise<SendOutcome> {
  let socket: SmtpSocket;
  try {
    socket = connect(
      { hostname: settings.host, port: settings.port },
      { secureTransport: settings.security === "tls" ? "on" : "starttls", allowHalfOpen: false },
    );
  } catch {
    return transient("connect");
  }

  let reader = new ReplyReader(socket.readable.getReader());
  let writer = socket.writable.getWriter();
  const write = (line: string) => writer.write(encoder.encode(`${line}\r\n`));
  const expect = async (step: string, ...codes: number[]): Promise<Reply> => {
    const reply = await reader.read();
    if (!codes.includes(reply.code)) throw new SmtpReplyError(reply.code, step);
    return reply;
  };

  try {
    await expect("greeting", 220);
    const helo = `EHLO ${email.from.email.split("@")[1] ?? "localhost"}`;
    await write(helo);
    let capabilities = await expect("ehlo", 250);

    if (settings.security === "starttls") {
      if (!hasCapability(capabilities, "STARTTLS")) return permanent("starttls_unavailable");
      await write("STARTTLS");
      await expect("starttls", 220);
      reader.release();
      writer.releaseLock();
      socket = socket.startTls();
      reader = new ReplyReader(socket.readable.getReader());
      writer = socket.writable.getWriter();
      await write(helo);
      capabilities = await expect("ehlo", 250);
    }

    const mechanisms = authMechanisms(capabilities);
    if (mechanisms.includes("PLAIN")) {
      await write(`AUTH PLAIN ${base64(`\u0000${settings.username}\u0000${settings.password}`)}`);
      await expect("auth", 235);
    } else if (mechanisms.includes("LOGIN")) {
      await write("AUTH LOGIN");
      await expect("auth", 334);
      await write(base64(settings.username));
      await expect("auth", 334);
      await write(base64(settings.password));
      await expect("auth", 235);
    } else {
      return permanent("auth_unsupported");
    }

    assertAddressSafe(email.from.email, email.to);
    await write(`MAIL FROM:<${email.from.email}>`);
    await expect("mail", 250);
    await write(`RCPT TO:<${email.to}>`);
    await expect("rcpt", 250, 251);
    await write("DATA");
    await expect("data", 354);
    await writer.write(encoder.encode(`${buildMime(email, now)}\r\n.\r\n`));
    const accepted = await expect("message", 250);
    await write("QUIT").catch(() => {});
    const queued = accepted.lines[0]?.match(/\b(?:queued as|id=)\s*([A-Za-z0-9.-]{1,64})/i)?.[1] ?? null;
    return sent(queued);
  } catch (error) {
    if (error instanceof SmtpReplyError) {
      const code = `smtp_${error.code}:${error.step}`;
      return error.code >= 500 ? permanent(code) : transient(code);
    }
    if (error instanceof SmtpProtocolError) {
      // An address or header we refuse to write never becomes sendable by retrying.
      if (/^(unsafe|line break)/.test(error.message)) return permanent(`smtp:${error.message}`);
      return transient(`smtp:${error.message}`);
    }
    return transient("network");
  } finally {
    await socket.close().catch(() => {});
  }
}

export function smtpDriver(settings: SmtpSettings, connect: SmtpConnect, now: () => number = Date.now): EmailDriver {
  return { kind: "smtp", send: (email) => sendSmtp(connect, settings, email, now()) };
}
