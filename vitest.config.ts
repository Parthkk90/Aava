import { defineConfig } from "vitest/config";

// Kohaku packages ship extensionless ESM imports that only bundlers resolve; let Vite process them.
const server = { deps: { inline: [/@kohaku-eth\//] } };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          server,
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "crops",
          environment: "node",
          server,
          include: ["tests/crops/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
