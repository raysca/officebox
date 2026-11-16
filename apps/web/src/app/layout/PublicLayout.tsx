import { Outlet } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import { messages } from "../messages";
import { useDocumentTitle } from "../Page";
import { ThemeSelect } from "./ThemeSelect";

/** A public page: document title, h1 and description, then the content. */
export function PublicPage({
  title,
  description,
  children,
  headingRef,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** The page heading, for pages that move focus to it. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  useDocumentTitle(title);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 ref={headingRef} data-page-heading tabIndex={-1} className="text-2xl font-semibold">
          {title}
        </h1>
        {description ? <p className="text-muted">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The frame for pages used before signing in (setup, sign-in): a header with the product name and
 * the theme choice, and the page in a centred column. Same landmarks as the shell: banner and main.
 */
export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex h-header items-center gap-2 border-b border-border bg-surface px-4">
        <p className="text-base font-semibold">{messages.appName}</p>
        <div className="ml-auto">
          <ThemeSelect />
        </div>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 justify-center px-4 py-8 focus:outline-none sm:py-12"
      >
        <div className="w-full max-w-md">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
