import type { CaptureIdentity } from "../../shared/app-sources/types"

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** Reconciles a helper response with the authorized request, never a renderer label. */
export function bindCapture(expected: CaptureIdentity, returned: CaptureIdentity): CaptureIdentity {
  for (const value of [expected, returned]) {
    if (!value || value.appType !== "#microsoft.graph.win32LobApp" || ![value.tenantId, value.appId, value.contentFileId].every(id => typeof id === "string" && GUID.test(id)) || typeof value.contentVersion !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.contentVersion)) throw new Error("Invalid capture content identity.")
  }
  for (const field of ["tenantId", "appId", "appType", "contentVersion", "contentFileId"] as const) {
    if (expected[field] !== returned[field]) throw new Error("The returned content does not match the authorized capture.")
  }
  return { tenantId: expected.tenantId, appId: expected.appId, appType: expected.appType, contentVersion: expected.contentVersion, contentFileId: expected.contentFileId }
}
