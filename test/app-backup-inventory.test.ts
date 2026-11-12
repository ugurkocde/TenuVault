import { describe, it, expect, vi } from "vitest"
import { readAppBackupApps } from "../src/main/app-backup/inventory"
const tenant = "11111111-1111-1111-1111-111111111111"
describe("App Backup live inventory", () => {
  it("follows beta pages, ignores count, filters exact Win32 types and deduplicates", async () => {
    const app = { id: tenant, displayName: "Finance", publisher: "Contoso", "@odata.type": "#microsoft.graph.win32LobApp" }
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ value: [app, { ...app, "@odata.type": "#microsoft.graph.macOSDmgApp" }], "@odata.count": 0, "@odata.nextLink": "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?$skiptoken=next" })).mockResolvedValueOnce(Response.json({ value: [app] }))
    const result = await readAppBackupApps(tenant, async () => "token", fetcher)
    expect(result.apps).toMatchObject([{ id: tenant, name: "Finance", publisher: "Contoso",version:null,icon:null }])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(["https://evil.test/beta/deviceAppManagement/mobileApps", "https://graph.microsoft.com/v1.0/deviceAppManagement/mobileApps", "https://graph.microsoft.com/beta/users"])("never sends credentials to an unexpected continuation %s", async next => {
    const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.nextLink": next }))
    await expect(readAppBackupApps(tenant, async () => "token", fetcher)).rejects.toThrow("continuation")
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("does not return a partial list after a later page fails", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/beta/deviceAppManagement/mobileApps?$skiptoken=next" })).mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
    await expect(readAppBackupApps(tenant, async () => "token", fetcher)).rejects.toThrow("HTTP 403")
  })
})
