import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env";
import type { TestObject } from "./fixtures/test-object";
import type * as MainModule from "./worker";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      SETUP_RELEASE_SQL: string;
      /** `ratelimits` from wrangler.jsonc (test/fake-rate-limit.ts). */
      TEST_RATE_LIMITS: { name: string; simple: { limit: number; period: number } }[];
      TEST_OBJECT: DurableObjectNamespace<TestObject>;
    }
    interface GlobalProps {
      mainModule: typeof MainModule;
      durableNamespaces: "SystemObject" | "UserHub" | "WorkspacePresence" | "TestObject";
    }
  }
}
