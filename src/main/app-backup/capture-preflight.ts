import { appMetadataGet } from "./graph-read"
import { sourceTenant } from "../app-sources/store"

/** Refusal-only check before consent. The elevated helper independently revalidates metadata. */
export async function checkCaptureMetadata(appId: string, token: string, fetchImpl: typeof fetch): Promise<void> {
  const id = sourceTenant(appId)
  if (!token) throw new Error("Reconnect this tenant's Microsoft session before starting Backup.")
  const row = await appMetadataGet(`https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/${id}?$select=id,microsoft.graph.win32LobApp/committedContentVersion,microsoft.graph.win32LobApp/installExperience`, token, fetchImpl)
  if (row.id !== id || row["@odata.type"] !== "#microsoft.graph.win32LobApp") throw new Error("Select a Win32 app in this tenant.")
  const experience = row.installExperience as Record<string, unknown> | null | undefined
  if (experience?.runAsAccount !== "system") throw new Error("This preview supports apps installed in the system context only.")
  if (typeof row.committedContentVersion !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.committedContentVersion)) {
    throw new Error("This app has no committed installer content in Intune. Choose an app with an uploaded installer.")
  }
}
