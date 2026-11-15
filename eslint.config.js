// ESLint flat config: typescript-eslint with type information, React hooks rules for the web app,
// and eslint-config-prettier last so formatting is left to Prettier.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/.wrangler/",
    "e2e/test-results/",
    "e2e/playwright-report/",
    // Reference prototypes with their own tooling; never imported (AGENTS §2).
    "spikes/",
  ]),

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // vite.config.ts is checked by apps/web/tsconfig.node.json, which isn't a tsconfig.json.
          allowDefaultProject: ["apps/web/vite.config.ts"],
          defaultProject: "apps/web/tsconfig.node.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // `any` needs a comment explaining why (AGENTS §4.1): disable the rule on that line with a reason.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  {
    // Plain JavaScript (Node scripts and this file) has no type information to lint against.
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  {
    // logUnredacted bypasses log redaction. Only the first-run setup token may use it (TDD §6.8); M1
    // adds that module to `ignores` here. Any other importer needs review. Imports are restricted
    // rather than calls, so aliasing or destructuring can't get around it.
    files: ["apps/worker/src/**/*.ts"],
    ignores: [],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/log-unredacted", "**/log-unredacted.ts"],
              message: "logUnredacted is reserved for the setup token (TDD §6.8). See eslint.config.js.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/log-unredacted/]",
          message: "logUnredacted is reserved for the setup token (TDD §6.8). See eslint.config.js.",
        },
      ],
    },
  },

  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: globals.browser },
  },

  prettier,
);
