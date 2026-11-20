import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ApiRequestError, describeApiError, errorCodeOf } from "../../lib/api/client";
import { meQueryKey, signInWithPasskey } from "../../lib/api/identity";
import { publicStatusQuery, requestMagicLink } from "../../lib/api/onboarding";
import { supportsPasskeys } from "../../lib/api/webauthn";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { Link } from "../../lib/ui/Link";
import { TextField } from "../../lib/ui/TextField";
import { describePasskeyFailure, emailError } from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";

const copy = messages.signIn;
const resetDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c /* backslash */) return true;
  }
  return false;
}

/**
 * Where to go after signing in. Only a same-origin path is accepted (`/x`, never `//host` or a URL),
 * so the parameter can't be used as an open redirect.
 */
export function safeRedirect(value: string | undefined, origin: string = window.location.origin): string {
  // Control characters and backslashes never belong in our paths, and URL parsers treat them in ways
  // that can turn "/…" into another host ("/\t/evil.example" and "/\\evil.example" both become "//evil.example").
  if (!value || !value.startsWith("/") || hasUnsafeCharacter(value)) return "/";
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  if (
    url.pathname === "/sign-in" ||
    url.pathname === "/setup" ||
    url.pathname === "/not-configured" ||
    url.pathname === "/sign-in/link" ||
    url.pathname === "/invitations/accept" ||
    url.pathname === "/auth/recover" ||
    url.pathname === "/recover" ||
    url.pathname === "/me/email/confirm" ||
    url.pathname === "/admin/domain/complete"
  ) {
    return "/";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export const signInSearchSchema = z.object({
  redirect: z.string().max(2000).optional().catch(undefined),
  /** Why the person is here: they signed out, or their session ended. */
  reason: z.enum(["signed-out", "expired"]).optional().catch(undefined),
});
export type SignInSearch = z.infer<typeof signInSearchSchema>;

/**
 * "Email me a sign-in link" (Identity §4.4, §7 screen 3), shown only when email is configured and
 * magic links are on. The answer never says whether the address has an account.
 */
function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: requestMagicLink,
    meta: { errorToast: false },
    onSuccess: (_result, sent) => setSentTo(sent),
    onError: (failure) => {
      if (errorCodeOf(failure) === "unavailable") setFormError(copy.linkUnavailable);
      else
        setFormError(
          failure instanceof ApiRequestError ? describeApiError(failure.detail, "mutation") : messages.errors.generic,
        );
    },
  });
  return (
    <section aria-labelledby="magic-link-heading" className="flex flex-col gap-4 border-t border-border pt-6">
      <div className="flex flex-col gap-1">
        <h2 id="magic-link-heading" className="text-lg font-semibold">
          {copy.linkSection}
        </h2>
        <p className="text-sm text-muted">{copy.linkDescription}</p>
      </div>
      {sentTo ? (
        <Alert tone="info">{copy.linkSent(sentTo)}</Alert>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(null);
            const problem = emailError(email);
            setError(problem);
            if (!problem) mutation.mutate(email.trim());
          }}
        >
          {formError ? <Alert>{formError}</Alert> : null}
          <TextField
            label={copy.emailLabel}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            error={error}
            required
            autoComplete="email"
          />
          <div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? copy.sendingLink : copy.sendLink}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Sign in (Identity §4.4, §7 screen 2): the passkey button first, a discoverable passkey, so no email
 * needs typing; then "Email me a sign-in link" for members when email is configured.
 */
export function SignInPage({ search }: { search: SignInSearch }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const supported = supportsPasskeys();
  const status = useQuery(publicStatusQuery);

  const mutation = useMutation({
    mutationFn: signInWithPasskey,
    meta: { errorToast: false },
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(describePasskeyFailure(result.error));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      await navigate({ href: safeRedirect(search.redirect), replace: true });
    },
  });

  const notice =
    search.reason === "signed-out" ? copy.signedOut : search.reason === "expired" ? copy.sessionEnded : null;

  const recoveryNotice = status.data?.recoveryNotice;

  return (
    <PublicPage title={copy.title} description={copy.description}>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {recoveryNotice ? <Alert>{copy.adminReset(resetDate.format(new Date(recoveryNotice.at)))}</Alert> : null}
      {!supported ? <Alert>{messages.passkey.unsupported}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <Button
          variant="primary"
          disabled={!supported || mutation.isPending}
          onClick={() => {
            setError(null);
            mutation.mutate();
          }}
        >
          {mutation.isPending ? copy.submitting : copy.submit}
        </Button>
      </div>
      {status.data?.magicLinks ? <MagicLinkForm /> : null}
      <p className="border-t border-border pt-6 text-sm text-muted">
        {copy.lostPasskeys} <Link to="/recover">{copy.ownerRecoveryLink}</Link>.
      </p>
    </PublicPage>
  );
}
