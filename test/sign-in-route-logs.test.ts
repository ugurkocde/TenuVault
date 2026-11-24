import { afterEach, expect, it, vi } from "vitest"
import { POST as tenantDetails } from "../src/portal/app/api/fetch-tenant-details/route"
import { POST as azureResources } from "../src/portal/app/api/list-azure-resources/route"
import { POST as backupContents } from "../src/portal/app/api/list-backup-contents/route"
import { POST as backups } from "../src/portal/app/api/list-backups/route"
import { POST as loadMetadata } from "../src/portal/app/api/tenant-metadata/load/route"
import { POST as saveMetadata } from "../src/portal/app/api/tenant-metadata/save/route"
import { POST as deleteMetadata } from "../src/portal/app/api/tenant-metadata/delete/route"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([
  [tenantDetails, "Graph"], [azureResources, "Azure"], [backupContents, "Azure"],
  [backups, "Azure"], [loadMetadata, "Azure", false], [saveMetadata, "Azure", false], [deleteMetadata, "Azure", false],
])("keeps sign-in details in the response and logs only the normalized code (%#)", async (route, label, returnsDetails = true) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const description = "Your session for admin@example.test has ended. Sign in again."
  const error = { error: "interaction_required", error_description: description }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(error, { status: 401 })))
  const body = { tenantId: "a1111111-1111-1111-1111-11111111111b", appId: "c3333333-3333-3333-3333-33333333333d", clientSecret: "fixture", storageAccountName: "fixture", subscriptionId: "fixture", resourceGroupName: "fixture", backupId: "backup-2026-01-01-120000", metadata: {} }
  const response = await route(new Request("https://desktop.test/api", { method: "POST", body: JSON.stringify(body) }) as never)
  expect(response.status).toBe(401)
  const result = await response.json()
  if (returnsDetails) expect(result).toMatchObject({ details: JSON.stringify(error) })
  else expect(result).toEqual({ error: "Failed to authenticate with Azure" })
  expect(log.mock.calls).toEqual([[`${label} auth error:`, "interaction_required"]])
})
