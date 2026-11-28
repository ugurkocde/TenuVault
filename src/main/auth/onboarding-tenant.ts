import { isGuid, normalizeGuid } from "../../shared/security"
import { ConnectionSwitchError } from "./switch-failure"
import { accessTokenClaims } from "./token-identity"

export const ORGANIZATIONS = "organizations"
const LOGIN = "https://login.microsoftonline.com"

export async function resolveOnboardingTenant(value: unknown, request: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  if (value === undefined || (typeof value === "string" && !value.trim())) return ORGANIZATIONS
  if (typeof value !== "string") throw new ConnectionSwitchError("invalid_request", "Enter a tenant ID or verified domain.")
  const tenant = value.trim().toLowerCase()
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
  const validDomain = tenant.length <= 253 && new RegExp(`^(?:${label}\\.)+${label}$`).test(tenant)
  if (isGuid(tenant)) return tenant
  if (!validDomain) {
    throw new ConnectionSwitchError("invalid_request", "Enter a tenant ID or verified domain.")
  }
  try {
    const timeout = AbortSignal.timeout(10_000)
    const response = await request(`${LOGIN}/${tenant}/v2.0/.well-known/openid-configuration`, {
      redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (response.ok) {
      const { issuer } = await response.json()
      if (typeof issuer === "string" && issuer.startsWith(`${LOGIN}/`) && issuer.endsWith("/v2.0")) {
        const id = issuer.slice(LOGIN.length + 1, -"/v2.0".length)
        if (isGuid(id)) return normalizeGuid(id)
      }
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
  }
  throw new ConnectionSwitchError("invalid_request", "Could not find a Microsoft tenant for this domain. Check the domain or enter the tenant ID.")
}

/** Use the ID token received through MSAL. Require a tenant claim for the multi-tenant authority. */
export function signedInTenant(authority: string, result: {
  account: { tenantId: string } | null
  tenantId?: string
  idToken?: string
  idTokenClaims?: { tid?: unknown }
}): string {
  const account = result.account
  if (!account) throw new ConnectionSwitchError("no_account", "Microsoft did not return an account for this sign-in.")
  const claim = result.idTokenClaims?.tid ?? accessTokenClaims(result.idToken)?.tid
  const tenant = claim === undefined && authority !== ORGANIZATIONS ? normalizeGuid(account.tenantId) : isGuid(claim) ? normalizeGuid(claim) : ""
  if (!isGuid(tenant) || tenant !== normalizeGuid(account.tenantId) ||
    (result.tenantId && tenant !== normalizeGuid(result.tenantId)) ||
    (isGuid(authority) && tenant !== normalizeGuid(authority))) {
    throw new ConnectionSwitchError("wrong_tenant", "You signed in to a different tenant. Sign in with an account from this tenant.")
  }
  return tenant
}
