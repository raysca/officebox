import { defineConfig } from "vitest/config";

// Pure-logic tests that need a real clock. Inside the Workers runtime the clock only advances on
// I/O (a Spectre mitigation), so CPU-time assertions such as "redacting 1 MB takes under 50 ms" run
// in Node instead. Only modules without Workers APIs may be imported here.
export default defineConfig({
  test: {
    include: ["test/node/**/*.test.ts"],
    environment: "node",
  },
});
