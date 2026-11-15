import { useEffect, type ReactNode } from "react";
import { pageTitle } from "./messages";

/** Sets the document title while the component is mounted (WCAG 2.4.2). */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = pageTitle(title);
  }, [title]);
}

export interface PageProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}

/**
 * The frame of every routed page: document title, and an h1 that receives focus after a client-side
 * navigation (the shell moves focus to `[data-page-heading]`), so screen-reader users hear where
 * they've arrived.
 */
export function Page({ title, description, children }: PageProps) {
  useDocumentTitle(title);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8">
      <div className="flex flex-col gap-1">
        <h1 data-page-heading tabIndex={-1} className="text-2xl font-semibold">
          {title}
        </h1>
        {description ? <p className="text-muted">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}
