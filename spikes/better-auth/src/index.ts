import { createApp } from "./app";
import type { Env } from "./auth";

export type { Env };
const app = createApp();
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
