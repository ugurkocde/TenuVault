import { PublicClientApplication } from "@azure/msal-node"
import { fetchNetworkClient } from "./network-client"
import { loopbackSignIn } from "./loopback-sign-in"
import { ERROR_PAGE, page, SIGN_IN_TIMEOUT_MS } from "./msal"
import { setupSignInError } from "./app-registration-setup"
import { isGuid, isMicrosoftLoginUrl } from "../../shared/security"
import { RegistrationAdditions, sameAdditionConnection, type AdditionConnection } from "./registration-additions"
import type { PermissionAdditionPreview, PermissionAdditionResult } from "../../shared/registration-additions"
import { grantedPermissions } from "../../shared/services/token"

export function permissionAdditionScopes(result: { accessToken: string }): string[] {
  const granted = grantedPermissions(result.accessToken)
  if (granted?.kind !== "delegated") throw new Error("Sign in with a delegated Graph account whose permissions can be read before adding permissions.")
  return [...granted.permissions]
}

export function verifyPermissionAdditionToken(result: { accessToken: string }, approved: readonly string[]): void {
  const scopes = new Set(permissionAdditionScopes(result).map(name => name.toLowerCase()))
  const missing = approved.filter(name => !scopes.has(name.toLowerCase()))
  if (missing.length) throw new Error(`The refreshed token still lacks ${missing.join(", ")}.`)
}

/** Setup-only consent is never persisted in the tenant's normal MSAL cache. */
export async function signInForPermissionAddition(connection: AdditionConnection, request: typeof fetch, openBrowser: (url: string) => Promise<void>, signal: AbortSignal): Promise<string> {
  const app = new PublicClientApplication({ auth: { clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e", authority: `https://login.microsoftonline.com/${connection.tenantId}` }, system: { networkClient: fetchNetworkClient(request) } })
  try {
    const result = await loopbackSignIn({ app, scopes: ["https://graph.microsoft.com/Application.ReadWrite.All", "https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All"], loginHint: connection.username, signal,
      openBrowser: url => { if (!isMicrosoftLoginUrl(url)) throw new Error("Microsoft returned an unexpected sign-in address."); return openBrowser(url) },
      successPage: page("Go back to TenuVault", "Review the permission changes in TenuVault. You can close this tab."), errorPage: ERROR_PAGE,
    })
    signal.throwIfAborted()
    if (!result.accessToken || result.account?.tenantId.toLowerCase() !== connection.tenantId.toLowerCase() || result.account?.username.toLowerCase() !== connection.username.toLowerCase() || result.account?.homeAccountId !== connection.homeAccountId) throw new Error("Sign in with the same tenant and account that is connected in TenuVault. Nothing was changed.")
    return result.accessToken
  } catch (error) { throw setupSignInError(error) }
  finally { await app.clearCache() }
}

interface Host {
  fetch: typeof fetch
  connection: (tenantId: string) => Promise<AdditionConnection>
  signIn: (connection: AdditionConnection, signal: AbortSignal) => Promise<string>
  refresh: (connection: AdditionConnection, approved: readonly string[]) => Promise<void>
}

/** One short-lived preview at a time. Its token and approved difference stay in the main process. */
export class AddPermissionsFlow {
  private pending?: { tenantId: string; controller: AbortController }
  private session?: { run: RegistrationAdditions; connection: AdditionConnection; expires: ReturnType<typeof setTimeout> }
  private applying = false
  constructor(private host: Host) {}
  cancel(tenantId: string): void {
    if (this.applying) return
    if (this.pending?.tenantId.toLowerCase() === tenantId.toLowerCase()) this.pending.controller.abort()
    if (this.session?.connection.tenantId.toLowerCase() === tenantId.toLowerCase()) { clearTimeout(this.session.expires); this.session = undefined }
  }
  async preview(tenantId: unknown, names: unknown): Promise<PermissionAdditionPreview> {
    if (!isGuid(tenantId) || !Array.isArray(names) || !names.length || names.some(n => typeof n !== "string")) throw new Error("Choose a connected tenant and its missing permissions.")
    if (this.pending || this.applying) throw new Error("A permission change is already running.")
    if (this.session) this.cancel(this.session.connection.tenantId)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS)
    this.pending = { tenantId, controller }
    try {
      const connection = await this.host.connection(tenantId)
      if (names.some(n => !connection.allowed.includes(n))) throw new Error("Choose permissions from the current services and access levels.")
      const token = await this.host.signIn(connection, controller.signal)
      controller.signal.throwIfAborted()
      const run = await RegistrationAdditions.prepare({ fetch: this.host.fetch, token, connection, additions: names })
      controller.signal.throwIfAborted()
      if (!sameAdditionConnection(connection, await this.host.connection(tenantId))) throw new Error("The connection or service choice changed. Start a new preview. Nothing was changed.")
      const expires = setTimeout(() => { this.session = undefined }, 10 * 60_000)
      expires.unref()
      this.session = { run, connection, expires }
      return run.preview
    } finally { clearTimeout(timer); this.pending = undefined }
  }
  async confirm(tenantId: unknown, id: unknown): Promise<PermissionAdditionResult> {
    const session = this.session
    if (!session || typeof tenantId !== "string" || session.connection.tenantId.toLowerCase() !== tenantId.toLowerCase() || session.run.preview.id !== id || this.applying) throw new Error("The permission preview expired or changed. Start a new preview.")
    this.session = undefined
    clearTimeout(session.expires)
    this.applying = true
    const assertConnection = async () => {
      if (!sameAdditionConnection(session.connection, await this.host.connection(tenantId))) throw new Error("The connection or service choice changed. Start a new preview.")
    }
    try {
      await assertConnection()
      const result = await session.run.apply(assertConnection)
      if (result.state !== "changed" || result.declared.length || result.consented.length) {
        try { await assertConnection(); await this.host.refresh(session.connection, [...new Set([...session.run.preview.declare, ...session.run.preview.consent])]) }
        catch (error) { result.state = "partial"; result.message += ` The tenant token refresh or health check did not complete: ${error instanceof Error ? error.message : String(error)} Select Check again, or sign in again, to verify access.` }
      }
      return result
    } finally { this.applying = false }
  }
}
