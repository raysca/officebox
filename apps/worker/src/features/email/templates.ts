import type { PasskeyCreatedVia, SecurityNoticeDetails, SecurityNoticeKind, WorkspaceRole } from "@officebox/shared";

/**
 * Fixed email templates (TDD §7.6; Notifications §6 "Template"). Every value from people or settings
 * (workspace name, names, emails) is **escaped**; nothing is free-form HTML. Each email has a plain-text
 * and an HTML part, and links are built by the caller from the canonical origin (Identity §2). Copy
 * uses the generic feature names (AGENTS §8).
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Subjects are one line: line breaks in a workspace name can't reach a header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

interface Paragraph {
  text: string;
  /** Wrap the given substring in <strong> in the HTML part. */
  strong?: string;
}

function layout(
  workspace: string,
  heading: string,
  paragraphs: Paragraph[],
  action?: { label: string; url: string },
  footer?: string,
): { text: string; html: string } {
  const textParts = [heading, "", ...paragraphs.map((p) => p.text)];
  if (action) textParts.push("", `${action.label}: ${action.url}`);
  if (footer) textParts.push("", footer);
  textParts.push("", `— ${workspace}`);

  const htmlParagraph = (p: Paragraph) => {
    let body = escapeHtml(p.text);
    if (p.strong) body = body.replace(escapeHtml(p.strong), `<strong>${escapeHtml(p.strong)}</strong>`);
    return `<p style="margin:0 0 16px">${body}</p>`;
  };
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 20px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(action.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#4b5563">Or copy this link into your browser: ${escapeHtml(action.url)}</p>`
    : "";
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f3f4f6;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">` +
    `<h1 style="margin:0 0 24px;font-size:20px">${escapeHtml(heading)}</h1>` +
    paragraphs.map(htmlParagraph).join("") +
    button +
    (footer ? `<p style="margin:24px 0 0;font-size:13px;color:#4b5563">${escapeHtml(footer)}</p>` : "") +
    `<p style="margin:24px 0 0;font-size:13px;color:#4b5563">${escapeHtml(workspace)}</p>` +
    `</div></body></html>`;
  return { text: textParts.join("\n"), html };
}

export function invitationEmail(input: {
  workspace: string;
  inviterName: string;
  email: string;
  link: string;
  expiresAt: number;
}): RenderedEmail {
  const workspace = oneLine(input.workspace);
  const expires = new Date(input.expiresAt).toUTCString();
  const body = layout(
    workspace,
    `You're invited to ${workspace}`,
    [
      { text: `${oneLine(input.inviterName)} invited you to join ${workspace} on Officebox.` },
      { text: `The invitation is for ${input.email}.`, strong: input.email },
      { text: `It works once and expires on ${expires}. You'll create a passkey to sign in; there's no password.` },
    ],
    { label: "Accept the invitation", url: input.link },
    "If you weren't expecting this, you can ignore this email.",
  );
  return { subject: `You're invited to ${workspace}`, ...body };
}

export function magicLinkEmail(input: { workspace: string; email: string; link: string }): RenderedEmail {
  const workspace = oneLine(input.workspace);
  const body = layout(
    workspace,
    `Sign in to ${workspace}`,
    [
      { text: `Use this link to sign in to ${workspace} as ${input.email}.`, strong: input.email },
      { text: "It works once and expires in 15 minutes." },
    ],
    { label: "Sign in", url: input.link },
    "If you didn't ask for this, you can ignore this email: nobody can sign in without the link.",
  );
  return { subject: `Sign in to ${workspace}`, ...body };
}

/** The email-change confirmation, sent to the **new** address (Identity §4.11; Platform §10). */
export function emailChangeEmail(input: {
  workspace: string;
  newEmail: string;
  actorName: string;
  link: string;
  expiresAt: number;
}): RenderedEmail {
  const workspace = oneLine(input.workspace);
  const expires = new Date(input.expiresAt).toUTCString();
  const body = layout(
    workspace,
    `Confirm your new email for ${workspace}`,
    [
      {
        text: `${oneLine(input.actorName)} changed the email address of your ${workspace} account to ${input.newEmail}.`,
        strong: input.newEmail,
      },
      { text: `Confirm it to make the change. The link works once and expires on ${expires}.` },
    ],
    { label: "Confirm the new address", url: input.link },
    "If you weren't expecting this, you can ignore this email: nothing changes until the link is used.",
  );
  return { subject: `Confirm your new email for ${workspace}`, ...body };
}

const VIA_LABEL: Record<PasskeyCreatedVia, string> = {
  setup: "during setup",
  invitation: "when accepting an invitation",
  recovery_link: "with a recovery link",
  owner_recovery: "with owner recovery",
  magic_link: "after signing in with an email link",
  signed_in: "while signed in",
  domain_move: "during the workspace's move to a new address",
};

const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "owner", admin: "admin", member: "member", guest: "guest" };

function noticeLines(kind: SecurityNoticeKind, details: SecurityNoticeDetails): { title: string; lines: string[] } {
  switch (kind) {
    case "passkey_added": {
      const name = details.passkeyName ? `"${oneLine(details.passkeyName)}"` : "A passkey";
      const via = details.createdVia ? ` ${VIA_LABEL[details.createdVia]}` : "";
      return {
        title: "A passkey was added to your account",
        lines: [`${name} was added to your account${via}.`],
      };
    }
    case "magic_link_new_device": {
      const where = [details.deviceLabel, details.approxLocation].filter(Boolean).join(", ");
      return {
        title: "New sign-in with an email link",
        lines: [
          `Someone signed in to your account with an email link from a device we haven't seen before${where ? ` (${where})` : ""}.`,
        ],
      };
    }
    case "passkey_clone_detected":
      return {
        title: details.subjectName ? "A copied passkey was refused" : "A copied passkey was refused on your account",
        lines: [
          details.subjectName
            ? `A sign-in to ${oneLine(details.subjectName)}'s account used what looks like a copy of one of their passkeys. It was refused.`
            : "A sign-in to your account used what looks like a copy of one of your passkeys. It was refused.",
        ],
      };
    case "recovery_link_issued":
      return {
        title: "A recovery link was issued for your account",
        lines: [
          `${details.actorName ? oneLine(details.actorName) : "An admin"} issued a recovery link for your account. Anyone with the link can add a passkey to your account until it's used or expires.`,
        ],
      };
    case "recovery_link_used": {
      const name = details.passkeyName ? `the passkey "${oneLine(details.passkeyName)}"` : "a passkey";
      return {
        title: "A recovery link was used on your account",
        lines: [`A recovery link was used to add ${name} to your account, and your other sessions were signed out.`],
      };
    }
    case "email_changed": {
      const to = details.newEmail ? ` to ${details.newEmail}` : "";
      const by = details.actorName ? ` by ${oneLine(details.actorName)}` : "";
      return {
        title: "Your email address was changed",
        lines: [`The email address on your account was changed${to}${by}.`],
      };
    }
    case "owner_recovery_used":
      return {
        title: "Owner recovery was used",
        lines: [
          details.subjectName
            ? `The owner recovery token was used to add a passkey to ${oneLine(details.subjectName)}'s account.`
            : "The owner recovery token was used to add a passkey to an owner's account.",
        ],
      };
    case "domain_moved": {
      const to = details.origin ? ` to ${details.origin}` : "";
      const by = details.actorName ? ` by ${oneLine(details.actorName)}` : " by an owner";
      return {
        title: "The workspace moved to a new address",
        lines: [
          `The workspace was moved${to}${by}. Everyone was signed out; passkeys made for the old address don't work at the new one.`,
        ],
      };
    }
    case "member_export":
      return { title: "An admin exported your data", lines: ["An admin exported a copy of your data."] };
    case "role_changed": {
      const to = details.newRole ? ROLE_LABEL[details.newRole] : "a new role";
      const by = details.actorName ? ` by ${oneLine(details.actorName)}` : "";
      return {
        title: "Your role was changed",
        lines: [`Your role in the workspace was changed to ${to}${by}.`],
      };
    }
  }
}

export function securityNoticeEmail(input: {
  workspace: string;
  kind: SecurityNoticeKind;
  details: SecurityNoticeDetails;
  at: number;
  signInUrl: string;
}): RenderedEmail {
  const workspace = oneLine(input.workspace);
  const { title, lines } = noticeLines(input.kind, input.details);
  const body = layout(
    workspace,
    title,
    [
      ...lines.map((text) => ({ text })),
      { text: `When: ${new Date(input.at).toUTCString()}.` },
      {
        text: "If this was you, there's nothing to do. If it wasn't, sign in with a passkey and check your passkeys and devices, or contact an owner.",
      },
    ],
    { label: `Open ${workspace}`, url: input.signInUrl },
    "You get security notices for your account whatever your notification settings.",
  );
  return { subject: `Security notice: ${title}`, ...body };
}

export function testEmail(input: { workspace: string; driver: string }): RenderedEmail {
  const workspace = oneLine(input.workspace);
  const body = layout(workspace, "Email works", [
    { text: `This is a test email from ${workspace}. Email is set up with the ${input.driver} driver.` },
    { text: "Invitations, sign-in links and security notices can now be emailed." },
  ]);
  return { subject: `Test email from ${workspace}`, ...body };
}
