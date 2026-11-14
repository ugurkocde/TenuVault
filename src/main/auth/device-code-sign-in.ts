import type { AuthenticationResult, DeviceCodeRequest } from "@azure/msal-node"
import type { AppDeviceCode } from "../../shared/app-sources/types"
import { RESOURCE_SCOPES } from "../../shared/constants"

/** Device codes authorize only the explicitly selected tenant's existing public-client session. */
export async function deviceCodeSignIn(tenant: string, acquire: (request: DeviceCodeRequest) => Promise<AuthenticationResult | null>, onCode: (code: AppDeviceCode) => void, signal: AbortSignal): Promise<AuthenticationResult> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(tenant)) throw new Error("Select a configured destination tenant.")
  const request: DeviceCodeRequest = {
    authority: `https://login.microsoftonline.com/${tenant}`,
    scopes: [RESOURCE_SCOPES.graph], timeout: 900,
    deviceCodeCallback: response => {
      signal.throwIfAborted()
      const url = new URL(response.verificationUri)
      if (url.protocol !== "https:" || !["microsoft.com", "www.microsoft.com", "login.microsoft.com", "login.microsoftonline.com"].includes(url.hostname) || url.port || url.username || url.password || url.hash || !/^[A-Z0-9-]{6,20}$/.test(response.userCode) || !Number.isFinite(response.expiresIn) || response.expiresIn <= 0 || response.expiresIn > 1800) throw new Error("Microsoft returned an invalid device sign-in challenge.")
      onCode({ verificationUri: url.href, userCode: response.userCode, expiresAt: new Date(Date.now() + response.expiresIn * 1000).toISOString() })
    },
  }
  const cancel = () => { request.cancel = true }
  signal.throwIfAborted(); signal.addEventListener("abort", cancel, { once: true })
  try {
    const result = await acquire(request)
    signal.throwIfAborted()
    if (!result?.account || result.account.tenantId.toLowerCase() !== tenant.toLowerCase()) throw new Error("The Microsoft account does not belong to the selected destination tenant.")
    return result
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && /\binvalid_client\b/.test(error.message)) throw new Error("Microsoft rejected device-code sign-in for this app registration. Check that Allow public client flows is enabled for this tenant's TenuVault app in Entra, or use browser sign-in on this computer.")
    throw error
  } finally { signal.removeEventListener("abort", cancel) }
}
