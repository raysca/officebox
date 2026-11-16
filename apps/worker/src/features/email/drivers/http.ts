import { sesSignedHeaders } from "./sigv4";
import {
  fromHeader,
  outcomeForStatus,
  providerCode,
  sent,
  transient,
  type EmailDriver,
  type Fetch,
  type OutgoingEmail,
  type SendOutcome,
} from "./types";

/**
 * HTTP API providers called with `fetch` (TDD §7.6): Resend, Postmark and Amazon SES (v2 API). Each key
 * is a Worker secret. A request that never gets a response (DNS, TLS, a reset connection) is transient;
 * HTTP 429 and 5xx are transient; every other 4xx is permanent. The job ID goes to Resend as its
 * `Idempotency-Key` and to Postmark as metadata; SES has no idempotency key.
 */

const TIMEOUT_MS = 15_000;

async function post(fetcher: Fetch, url: string, init: RequestInit): Promise<Response | SendOutcome> {
  try {
    return await fetcher(url, { ...init, method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return transient("network");
  }
}

export function resendDriver(apiKey: string, fetcher: Fetch): EmailDriver {
  return {
    kind: "resend",
    async send(email: OutgoingEmail) {
      const response = await post(fetcher, "https://api.resend.com/emails", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.id,
        },
        body: JSON.stringify({
          from: fromHeader(email.from),
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
        }),
      });
      if (!(response instanceof Response)) return response;
      if (response.ok) {
        const id = await providerCode(response, "id");
        return sent(id ?? null);
      }
      return outcomeForStatus(response.status, await providerCode(response, "name"));
    },
  };
}

export function postmarkDriver(serverToken: string, fetcher: Fetch): EmailDriver {
  return {
    kind: "postmark",
    async send(email: OutgoingEmail) {
      const response = await post(fetcher, "https://api.postmarkapp.com/email", {
        headers: {
          "X-Postmark-Server-Token": serverToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          From: fromHeader(email.from),
          To: email.to,
          Subject: email.subject,
          TextBody: email.text,
          HtmlBody: email.html,
          MessageStream: "outbound",
          Metadata: { officeboxJob: email.id },
        }),
      });
      if (!(response instanceof Response)) return response;
      if (response.ok) return sent((await providerCode(response, "MessageID")) ?? null);
      return outcomeForStatus(response.status, await providerCode(response, "ErrorCode"));
    },
  };
}

export interface SesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export function sesDriver(credentials: SesCredentials, fetcher: Fetch, now: () => number = Date.now): EmailDriver {
  return {
    kind: "ses",
    async send(email: OutgoingEmail) {
      const host = `email.${credentials.region}.amazonaws.com`;
      const path = "/v2/email/outbound-emails";
      const body = JSON.stringify({
        FromEmailAddress: fromHeader(email.from),
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: { Text: { Data: email.text, Charset: "UTF-8" }, Html: { Data: email.html, Charset: "UTF-8" } },
          },
        },
      });
      const headers = await sesSignedHeaders({ ...credentials, host, path, body, now: now() });
      const response = await post(fetcher, `https://${host}${path}`, { headers, body });
      if (!(response instanceof Response)) return response;
      if (response.ok) return sent((await providerCode(response, "MessageId")) ?? null);
      // SES names its errors in the x-amzn-ErrorType header (`TooManyRequestsException:…`).
      const type = response.headers.get("x-amzn-ErrorType")?.split(":")[0]?.slice(0, 60);
      return outcomeForStatus(response.status, type);
    },
  };
}
