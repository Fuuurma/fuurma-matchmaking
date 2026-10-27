import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "worker",
          include: ["src/**/*.test.ts", "client/test/contract/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "online-client",
          environment: "node",
          include: ["client/test/unit/**/*.test.ts"],
        },
      },
    ],
  },
})
