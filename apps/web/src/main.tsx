// Must come first: configures Zod for the CSP before any schema is used.
import "./lib/zod-config";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createAppClients } from "./app/clients";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const { queryClient, router } = createAppClients();

createRoot(root).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
