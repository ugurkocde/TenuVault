import { expect, it, vi } from "vitest"
import { checkCaptureMetadata } from "../src/main/app-backup/capture-preflight"
const id = "11111111-1111-1111-1111-111111111111"
const row = { id, "@odata.type": "#microsoft.graph.win32LobApp", installExperience: { runAsAccount: "system" }, committedContentVersion: "1" }

it("checks current beta metadata without granting capture authorization", async () => {
  const fetcher = vi.fn(async () => Response.json(row))
  await checkCaptureMetadata(id, "token", fetcher)
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`/beta/deviceAppManagement/mobileApps/${id}?`), expect.objectContaining({ method: "GET", redirect: "error" }))
})
it.each([null, undefined, "", 0, "0", "01", "bad", "123456789012345678901"])("explains absent or invalid committed content before helper launch: %s", async committedContentVersion => {
  await expect(checkCaptureMetadata(id, "token", async () => Response.json({ ...row, committedContentVersion }))).rejects.toThrow("no committed installer content")
})
it.each([{ id: "22222222-2222-2222-2222-222222222222" }, { "@odata.type": "#microsoft.graph.macOSDmgApp" }, { installExperience: null }, { installExperience: { runAsAccount: "user" } }])("refuses an ineligible or mismatched app", async changed => {
  await expect(checkCaptureMetadata(id, "token", async () => Response.json({ ...row, ...changed }))).rejects.toThrow()
})
it("requires a valid app and token before contacting Graph", async () => {
  const fetcher = vi.fn()
  await expect(checkCaptureMetadata("invalid", "token", fetcher)).rejects.toThrow()
  await expect(checkCaptureMetadata(id, "", fetcher)).rejects.toThrow("Reconnect")
  expect(fetcher).not.toHaveBeenCalled()
})
