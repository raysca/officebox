import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../lib/ui/Button";
import { AlertIcon } from "../lib/ui/icons";
import { messages, pageTitle } from "./messages";

export interface ErrorPageProps {
  /**
   * True when the shell itself failed, so the page supplies its own <main> landmark. Inside the
   * shell (a route failed) it renders into the shell's <main>.
   */
  standalone?: boolean;
}

/**
 * The page shown when rendering fails unexpectedly. It never shows the error itself (that could leak
 * internal detail); the error goes to the console for developers. It doesn't use the router, so it
 * works even when the router is what failed.
 */
export function ErrorPage({ standalone = false }: ErrorPageProps) {
  useEffect(() => {
    document.title = pageTitle(messages.error.title);
    document.querySelector<HTMLElement>("[data-error-heading]")?.focus();
  }, []);

  const content = (
    // Focus moves to the heading, which announces the error; no role="alert" so it isn't read twice.
    <div className="mx-auto flex max-w-xl flex-col items-start gap-4 px-4 py-12 sm:px-8">
      <AlertIcon width={32} height={32} className="text-danger" />
      <h1 data-error-heading tabIndex={-1} className="text-2xl font-semibold">
        {messages.error.title}
      </h1>
      <p className="text-muted">{messages.error.description}</p>
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="primary" onClick={() => window.location.reload()}>
          {messages.error.reload}
        </Button>
        <a href="/" className="rounded-sm text-accent underline underline-offset-2 hover:text-accent-hover">
          {messages.error.home}
        </a>
      </div>
    </div>
  );

  return standalone ? <main className="min-h-dvh bg-bg text-fg">{content}</main> : content;
}

/** Router error component for a failed route: logs the error and shows the error page in the shell. */
export function RouteErrorPage({ error }: { error: unknown }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorPage />;
}

/** Router error component for the root route: the shell isn't available, so the page stands alone. */
export function RootErrorPage({ error }: { error: unknown }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ErrorPage standalone />;
}

/** Last-resort boundary around the whole app, for failures outside the router (its providers). */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    return this.state.failed ? <ErrorPage standalone /> : this.props.children;
  }
}
