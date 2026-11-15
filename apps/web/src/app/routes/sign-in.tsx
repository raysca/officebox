import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { meQueryKey, signInWithPasskey } from "../../lib/api/identity";
import { supportsPasskeys } from "../../lib/api/webauthn";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { describePasskeyFailure } from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";

const copy = messages.signIn;

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
  if (url.pathname === "/sign-in" || url.pathname === "/setup" || url.pathname === "/not-configured") return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

export const signInSearchSchema = z.object({
  redirect: z.string().max(2000).optional().catch(undefined),
  /** Why the person is here: they signed out, or their session ended. */
  reason: z.enum(["signed-out", "expired"]).optional().catch(undefined),
});
export type SignInSearch = z.infer<typeof signInSearchSchema>;

/**
 * Sign in (Identity §4.4, §7 screen 2): one button, a discoverable passkey, so no email needs typing.
 * "Email me a sign-in link" for members arrives with email in M1b.
 */
export function SignInPage({ search }: { search: SignInSearch }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const supported = supportsPasskeys();

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

  return (
    <PublicPage title={copy.title} description={copy.description}>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
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
    </PublicPage>
  );
}
