/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Vite server proxies Worker paths to `wrangler dev` (see scripts/dev.mjs).
const WORKER_ORIGIN = process.env.WORKER_ORIGIN ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": WORKER_ORIGIN,
      "/health": WORKER_ORIGIN,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    // Let ?raw CSS imports through (tokens.test.ts reads index.css); Vitest empties CSS otherwise.
    css: { include: [/index\.css/] },
  },
});
