import { describe, expect, it, vi } from "vitest"
import { ApiHost, MAX_IPC_BODY_BYTES, routesFromGlob, type RouteModule } from "../src/main/api/host"
import { NextResponse, type NextRequest } from "../src/main/api/next-server-shim"

describe("routesFromGlob", () => {
  it("maps route files to API paths", () => {
    const routes = routesFromGlob({
      "../../../../src/app/api/list-backups/route.ts": { POST: vi.fn() },
      "../../../../src/app/api/tenant-metadata/save/route.ts": { POST: vi.fn() },
    })
    expect(Object.keys(routes).sort()).toEqual(["/api/list-backups", "/api/tenant-metadata/save"])
  })
})

describe("ApiHost", () => {
  const echo: RouteModule = {
    POST: async (request: NextRequest) =>
      NextResponse.json({ received: await request.json(), query: request.nextUrl.searchParams.get("q") }, { status: 201 }),
    GET: async () => new NextResponse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { "content-type": "application/zip" } }),
  }

  it("runs route handlers and serializes responses for IPC", async () => {
    const host = new ApiHost({ routes: { "/api/echo": echo } })
    const response = await host.handleIpc({
      method: "POST",
      path: "/api/echo?q=1",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ tenantId: "t" })),
    })
    expect(response.status).toBe(201)
    expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({ received: { tenantId: "t" }, query: "1" })
  })

  it("keeps binary bodies intact", async () => {
    const host = new ApiHost({ routes: { "/api/echo": echo } })
    const response = await host.handleIpc({ method: "GET", path: "/api/echo", headers: {} })
    expect(Array.from(response.body)).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(response.headers["content-type"]).toBe("application/zip")
  })

  it("returns 404 and 405 for unknown routes and methods", async () => {
    const host = new ApiHost({ routes: { "/api/echo": echo } })
    expect((await host.dispatch(new Request("http://x/api/nope"))).status).toBe(404)
    expect((await host.dispatch(new Request("http://x/api/echo", { method: "DELETE" }))).status).toBe(405)
  })

  it("lets the guard block requests before handlers run", async () => {
    const handler = vi.fn()
    const host = new ApiHost({
      routes: { "/api/echo": { POST: handler } },
      guard: () => Response.json({ error: "license" }, { status: 402 }),
    })
    const response = await host.dispatch(new Request("http://x/api/echo", { method: "POST", body: "{}" }))
    expect(response.status).toBe(402)
    expect(handler).not.toHaveBeenCalled()
  })

  it("turns thrown errors into 500 responses", async () => {
    const host = new ApiHost({
      routes: {
        "/api/boom": {
          POST: async () => {
            throw new Error("kaboom")
          },
        },
      },
    })
    const response = await host.dispatch(new Request("http://x/api/boom", { method: "POST" }))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "kaboom" })
  })

  it("refuses IPC bodies over the size limit before handlers run", async () => {
    const handler = vi.fn()
    const host = new ApiHost({ routes: { "/api/echo": { POST: handler } } })
    const response = await host.handleIpc({
      method: "POST",
      path: "/api/echo",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(MAX_IPC_BODY_BYTES + 1),
    })
    expect(response.status).toBe(413)
    expect(new TextDecoder().decode(response.body)).toContain("too large")
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects IPC paths outside /api", async () => {
    const host = new ApiHost({ routes: {} })
    expect((await host.handleIpc({ method: "GET", path: "file:///etc/passwd", headers: {} })).status).toBe(400)
  })
})
