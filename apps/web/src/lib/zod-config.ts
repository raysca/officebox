import { z } from "zod";

/**
 * The production CSP forbids eval (`script-src 'self'`, TDD §8.2). Zod 4 otherwise probes for it
 * with `new Function`, which a strict CSP reports as a violation even though Zod catches the error,
 * and then compiles faster object parsers with it. Jitless mode skips both. Imported first by
 * main.tsx, before any schema parses.
 */
z.config({ jitless: true });
