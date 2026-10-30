import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "../src/main/api/next-server-shim"
import { POST } from "../src/portal/app/api/cloud-backup-status/route"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "33333333-3333-3333-3333-333333333333"

afterEach(() => vi.unstubAllGlobals())

function statusBody(tenantId: string) {
  return {
    LastRunAt: "2026-10-30T02:02:00.000Z",
    LastStatus: "Success",
    LastMessage: "Backup Success, 42 policies.",
    BackupFolder: "backup-2026-10-30-020000",
    RunbookVersion: "1.0.0",
    Source: "TenuVault Cloud Backup",
    TenantId: tenantId,
  }
}

function serve(blob: () => Response) {
  const urls: string[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "token" })
    return blob()
  }))
  return urls
}

const request = (body: Record<string, unknown>) =>
  new NextRequest("http://tenuvault.internal/api/cloud-backup-status", { method: "POST", body: JSON.stringify(body) })
const valid = { tenantId: TENANT, appId: "app", clientSecret: "test", storageAccountName: "tvbkp123" }

describe("cloud-backup-status route", () => {
  it("reads this tenant's per tenant status blob and nothing else", async () => {
    const urls = serve(() => Response.json(statusBody(TENANT)))
    const data = await (await POST(request(valid))).json()
    expect(data.cloudStatus).toMatchObject({ lastStatus: "Success", backupFolder: "backup-2026-10-30-020000" })
    expect(urls[1]).toContain("/intune-backups/cloud-backup-status-11111111.json")
  })

  it("reports no cloud run yet on 404 and never another tenant's status", async () => {
    serve(() => new Response("", { status: 404 }))
    expect((await (await POST(request(valid))).json()).cloudStatus).toBeNull()
    serve(() => Response.json(statusBody(OTHER)))
    expect((await (await POST(request(valid))).json()).cloudStatus).toBeNull()
  })

  it("refuses malformed requests before any fetch", async () => {
    const urls = serve(() => Response.json(statusBody(TENANT)))
    expect((await POST(request({ ...valid, tenantId: "nope" }))).status).toBe(400)
    expect((await POST(request({ ...valid, storageAccountName: "Bad Account!" }))).status).toBe(400)
    expect(urls).toHaveLength(0)
  })
})
