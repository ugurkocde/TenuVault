import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig(({ mode }) => {
  // Lab tenant tests run separately with `npm run test:e2e` (vitest --mode e2e).
  const e2e = mode === "e2e"
  return {
    resolve: {
      alias: [
        { find: /^next\/server$/, replacement: resolve(import.meta.dirname, "src/main/api/next-server-shim.ts") },
        { find: /^next\/cache$/, replacement: resolve(import.meta.dirname, "src/main/api/next-cache-shim.ts") },
        { find: /^next\/headers$/, replacement: resolve(import.meta.dirname, "src/main/api/next-headers-shim.ts") },
        { find: /^~\//, replacement: `${resolve(import.meta.dirname, "src/portal")}/` },
      ],
    },
    test: {
      include: e2e ? ["test/**/*.e2e.test.ts"] : ["test/**/*.test.ts"],
      exclude: e2e ? [] : ["test/**/*.e2e.test.ts"],
      testTimeout: e2e ? 120_000 : 5_000,
      environment: "node",
      coverage: e2e ? undefined : {
        provider: "v8",
        reporter: ["text-summary", "lcov"],
        include: ["src/**"],
        exclude: ["src/**/*.html"],
        thresholds: {
          "src/main/**": { lines: 84 },
          "src/shared/**": { lines: 91 },
        },
      },
    },
  }
})
