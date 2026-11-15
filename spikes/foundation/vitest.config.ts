import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PEPPER_1: "test-pepper-1-0123456789abcdef0123456789abcdef",
          PEPPER_2: "test-pepper-2-fedcba9876543210fedcba9876543210",
        },
      },
    }),
  ],
  test: {
    testTimeout: 60_000,
  },
});
