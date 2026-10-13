import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig(({ mode }) => {
  // Lab tenant tests run separately with `npm run test:e2e` (vitest --mode e2e).
  const e2e = mode === "e2e"
  const alias = [
    { find: /^next\/server$/, replacement: resolve(import.meta.dirname, "src/main/api/next-server-shim.ts") },
    { find: /^next\/cache$/, replacement: resolve(import.meta.dirname, "src/main/api/next-cache-shim.ts") },
    { find: /^next\/headers$/, replacement: resolve(import.meta.dirname, "src/main/api/next-headers-shim.ts") },
    { find: /^next\/navigation$/, replacement: resolve(import.meta.dirname, "src/renderer/shims/next-navigation.ts") },
    { find: /^@desktop\//, replacement: `${resolve(import.meta.dirname, "src/renderer")}/` },
    { find: /^~\//, replacement: `${resolve(import.meta.dirname, "src/portal")}/` },
  ]
  if (e2e) {
    return {
      resolve: { alias },
      test: {
        include: ["test/**/*.e2e.test.ts"],
        testTimeout: 120_000,
        environment: "node",
      },
    }
  }
  return {
    resolve: { alias },
    test: {
      coverage: {
        provider: "v8",
        reporter: ["text-summary", "lcov"],
        include: ["src/**"],
        exclude: ["src/**/*.html"],
        thresholds: {
          "src/main/**": { lines: 84 },
          "src/shared/**": { lines: 91 },
          "src/portal/**": { lines: 47 },
          "src/renderer/**": { lines: 7 },
        },
      },
      projects: [
        {
          extends: true,
          test: {
            name: "node",
            include: ["test/**/*.test.ts"],
            exclude: ["test/**/*.e2e.test.ts", "test/renderer-hooks/**"],
            environment: "node",
            testTimeout: 5_000,
          },
        },
        {
          extends: true,
          test: {
            name: "renderer-hooks",
            include: ["test/renderer-hooks/**/*.test.ts"],
            environment: "jsdom",
            testTimeout: 5_000,
          },
        },
      ],
    },
  }
})
