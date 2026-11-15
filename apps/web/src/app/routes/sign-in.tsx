import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { ApiRequestError, describeApiError, errorCodeOf } from "../../lib/api/client";
import { meQueryKey, signInWithPassword } from "../../lib/api/identity";
import { Alert } from "../../lib/ui/Alert";
import { Button } from "../../lib/ui/Button";
import { TextField } from "../../lib/ui/TextField";
import { emailError, focusFirstInvalid, requiredError, type FieldErrors } from "../forms";
import { PublicPage } from "../layout/PublicLayout";
import { messages } from "../messages";

const copy = messages.signIn;

/**
 * Where to go after signing in. Only a same-origin path is accepted (`/x`, never `//host` or a URL),
 * so the parameter can't be used as an open redirect.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c /* backslash */) return true;
  }
  return false;
}

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
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (url.pathname === "/sign-in" || url.pathname === "/setup" || url.pathname === "/not-configured") return "/";
  return path;
}

export const signInSearchSchema = z.object({
  redirect: z.string().max(2000).optional().catch(undefined),
  email: z.string().max(254).optional().catch(undefined),
  /** Why the person is here: they signed out, or their session ended. */
  reason: z.enum(["signed-out", "expired"]).optional().catch(undefined),
});
export type SignInSearch = z.infer<typeof signInSearchSchema>;

type Field = "email" | "password";

/** Email and password sign-in (Identity §4.4, §7 screen 2). Magic links and passkeys arrive in M1c. */
export function SignInPage({ search }: { search: SignInSearch }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState(search.email ?? "");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: signInWithPassword,
    meta: { errorToast: false },
    onSuccess: async (me) => {
      queryClient.setQueryData(meQueryKey, me);
      await navigate({ href: safeRedirect(search.redirect), replace: true });
    },
    onError: async (error) => {
      const code = errorCodeOf(error);
      if (code === "setup_required") {
        await navigate({ to: "/setup" });
        return;
      }
      if (code === "unavailable") {
        await navigate({ to: "/not-configured" });
        return;
      }
      setPassword("");
      if (code === "invalid_credentials") setFormError(copy.invalid);
      else if (code === "forbidden") setFormError(copy.refused);
      else if (code === "rate_limited" && error instanceof ApiRequestError && error.detail.kind === "api") {
        setFormError(copy.tooMany(error.detail.error.retryAfterSeconds ?? 30));
      } else {
        setFormError(
          error instanceof ApiRequestError ? describeApiError(error.detail, "mutation") : messages.errors.generic,
        );
      }
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const found: FieldErrors<Field> = {};
    const e = emailError(email);
    const p = requiredError(password);
    if (e) found.email = e;
    if (p) found.password = p;
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    mutation.mutate({ email: email.trim(), password });
  }

  const notice =
    search.reason === "signed-out" ? copy.signedOut : search.reason === "expired" ? copy.sessionEnded : null;

  return (
    <PublicPage title={copy.title}>
      {notice && !formError ? <Alert tone="info">{notice}</Alert> : null}
      {formError ? <Alert>{formError}</Alert> : null}
      <form ref={formRef} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <TextField
          label={copy.emailLabel}
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (errors.email) setErrors((c) => ({ ...c, email: undefined }));
          }}
          error={errors.email}
          required
          autoComplete="username"
          autoFocus={!search.email}
        />
        <TextField
          label={copy.passwordLabel}
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (errors.password) setErrors((c) => ({ ...c, password: undefined }));
          }}
          error={errors.password}
          required
          autoComplete="current-password"
          autoFocus={Boolean(search.email)}
        />
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending ? copy.submitting : copy.submit}
        </Button>
      </form>
    </PublicPage>
  );
}
