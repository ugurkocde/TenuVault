import { describe, expect, it, vi } from "vitest"
import { ApiHost, DOWNLOAD_CANCELLED_HEADER, MAX_IPC_BODY_BYTES, routesFromGlob, type RouteModule } from "../src/main/api/host"
import { NextResponse, type NextRequest } from "../src/main/api/next-server-shim"
import { saveArchiveResponse } from "../src/main/backup/large-archive"
import { localRoutesRunning, routeUsesLocalStorage } from "../src/main/storage/blob-emulator"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

  it.each(["saved", "cancelled", "failed"])("holds the local folder guard through a %s archive save", async outcome => {
    const tenant = "11111111-1111-1111-1111-111111111111"
    const folder = await mkdtemp(join(tmpdir(), "tv-archive-save-"))
    const destination = join(folder, "backup.tar")
    let finish!: (choice: { canceled: boolean; filePath?: string }) => void
    const choice = new Promise<{ canceled: boolean; filePath?: string }>(resolve => { finish = resolve })
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start: controller => { stream = controller } })
    const guards: boolean[] = []
    const host = new ApiHost({
      routes: { "/api/download-backup": { POST: () => {
        guards.push(localRoutesRunning() && routeUsesLocalStorage(tenant))
        return new Response(body, { headers: { "content-type": "application/x-tar" } })
      } } },
      saveDownload: response => saveArchiveResponse(response, () => {
        guards.push(localRoutesRunning() && routeUsesLocalStorage(tenant))
        return choice
      }),
    })
    const pending = host.dispatch(new Request("http://x/api/download-backup", {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant, storageAccountName: `tvlocal-${tenant}` }),
    }))
    try {
      await vi.waitFor(() => expect(guards).toHaveLength(2))
      const busyWhileChoosing = localRoutesRunning()
      if (outcome === "cancelled") {
        stream.error(new Error("Stream failed before the save was cancelled"))
        finish({ canceled: true })
      } else {
        finish({ canceled: false, filePath: destination })
        await new Promise(resolve => setImmediate(resolve))
        guards.push(localRoutesRunning())
        if (outcome === "failed") stream.error(new Error("Archive read failed"))
        else { stream.enqueue(new Uint8Array([1, 2, 3])); stream.close() }
      }
      const response = await pending
      expect(localRoutesRunning()).toBe(false)
      expect(response.status).toBe(outcome === "failed" ? 500 : 200)
      expect(response.headers.get(DOWNLOAD_CANCELLED_HEADER)).toBe(outcome === "cancelled" ? "1" : null)
      if (outcome === "saved") expect(await readFile(destination)).toEqual(Buffer.from([1, 2, 3]))
      expect(busyWhileChoosing).toBe(true)
      expect(guards).toEqual(outcome === "cancelled" ? [true, true] : [true, true, true])
    } finally { await rm(folder, { recursive: true, force: true }) }
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
