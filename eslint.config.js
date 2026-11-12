import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "contracts/**",
      "infra/data/**",
      "**/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Security rules: no dynamic code execution anywhere in the codebase.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Unsafe HTML rendering is forbidden (XSS). Render text nodes instead.",
        },
      ],
      "no-restricted-properties": [
        "error",
        { object: "localStorage", property: "setItem", message: "Use the vault storage abstraction; never write secrets to localStorage." },
      ],
    },
  },
  {
    // Every chain read in the app goes through the RPC seam, so anonymous and
    // light-client modes cannot be bypassed by a stray direct client.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/runtime/rpc.ts", "apps/web/src/runtime/wallet.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "viem",
              importNames: ["http", "webSocket", "fallback"],
              message: "Read the chain through runtime.readClient() / RpcRouter (apps/web/src/runtime/rpc.ts) so RPC routing (direct, anonymous, light client) is enforced.",
            },
          ],
        },
      ],
    },
  },
);
