import { z } from "zod";

/**
 * The production CSP forbids eval (`script-src 'self'`, TDD §8.2). Zod 4 otherwise probes for it
 * with `new Function`, which a strict CSP reports as a violation even though Zod catches the error,
 * and then compiles faster object parsers with it. Jitless mode skips both.
 *
 * This module is imported only for its side effect, as the first import of main.tsx:
 * - it must stay first, because Zod caches the eval probe the first time a schema parses;
 * - it must not be tree-shaken: apps/web/package.json declares no `"sideEffects": false`, so
 *   bundlers keep side-effect imports. Don't add that flag without listing this file.
 * zod-config.test.ts checks the setting takes effect.
 */
z.config({ jitless: true });
