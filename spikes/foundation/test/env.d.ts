import type { Env as AppEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      PEPPER_2: string;
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
