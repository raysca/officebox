import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AppErrorBoundary } from "./ErrorPage";
import type { AppRouter } from "./router";

export interface AppProps {
  router: AppRouter;
  queryClient: QueryClient;
}

/** The app's providers: a last-resort error boundary, TanStack Query and the router. */
export function App({ router, queryClient }: AppProps) {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
