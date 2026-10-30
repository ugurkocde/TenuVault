import { describe, expect, it } from "vitest"
import { routesFromGlob } from "../src/main/api/host"

/**
 * Loads the real API route modules with the Next.js shims, the same way the
 * main-process bundle does.
 */
describe("portal API routes", () => {
  const routes = routesFromGlob(
    import.meta.glob("../src/portal/app/api/**/route.ts", { eager: true }),
  )

  it("load under the Next.js shims", () => {
    expect(Object.keys(routes).length).toBe(26)
    for (const path of ["/api/list-backups", "/api/restore-backup", "/api/restore-validate", "/api/detect-drifts", "/api/fetch-tenant-details", "/api/frameworks", "/api/oib", "/api/restore-journal", "/api/cloud-backup-status"]) {
      expect(routes[path]?.POST, path).toBeTypeOf("function")
    }
  })

  it("validate requests before calling Microsoft", async () => {
    const { NextRequest } = await import("../src/main/api/next-server-shim")
    const response = await routes["/api/list-backups"]!.POST!(
      new NextRequest("http://tenuvault.internal/api/list-backups", { method: "POST", body: "{}" }),
    )
    expect(response.status).toBe(400)
  })
})
