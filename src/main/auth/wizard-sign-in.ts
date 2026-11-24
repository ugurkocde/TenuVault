import { randomUUID } from "node:crypto"
import { checkedOnboardingChoice } from "../../shared/services/onboarding"
import type { PermissionChoice } from "../../shared/services/manifest"
import { graphCliCoverage } from "../../shared/services/graph-cli-coverage"
import { isGuid } from "../../shared/security"
import { GRAPH_CLI_DISABLED, TENUVAULT_CLIENT_ID, GRAPH_CLI_CLIENT_ID, type WizardSignInMethod, type WizardSignInResponse } from "../../shared/tenant-connection"
import { sharedTokenScopes } from "./token-identity"
import type { StagedSignIn } from "./tenant-connections"
import { ConnectionSwitchError } from "./switch-failure"

const EXPIRED = "This sign-in expired. Sign in again to continue."

export function wizardChoice(value: unknown): PermissionChoice {
  try { return checkedOnboardingChoice(value) } catch { throw new ConnectionSwitchError("invalid_request", "Choose at least one service with a supported access level.") }
}

export function wizardFailure(error: unknown) {
  const failure = error instanceof ConnectionSwitchError ? error : new ConnectionSwitchError("switch_failed", "TenuVault could not finish connecting this tenant. Check your sign-in and license and try again.")
  return { error: { code: failure.code, message: failure.message } }
}

interface PendingSignIn {
  id: string
  method: WizardSignInMethod
  staged: StagedSignIn
  choice?: PermissionChoice
}

export class WizardSignIn {
  private pending?: PendingSignIn
  private expiry?: ReturnType<typeof setTimeout>
  private busy = false
  private cleanup = Promise.resolve()

  constructor(private readonly host: {
    connected: (tenant: string) => boolean
    enabled: (method: WizardSignInMethod) => Promise<boolean>
    stage: (tenant: string, method: WizardSignInMethod, choice?: PermissionChoice) => Promise<StagedSignIn>
    checkLicense: (staged: StagedSignIn) => Promise<void>
    releaseLicense: (staged: StagedSignIn) => Promise<void>
    enroll: (draft: PendingSignIn, profile: string, choice: PermissionChoice) => void
  }) {}

  private async requireMethod(method: WizardSignInMethod) {
    if (!await this.host.enabled(method)) throw new ConnectionSwitchError("unavailable",
      method === "graphCli" ? GRAPH_CLI_DISABLED : "TenuVault app sign-in is currently unavailable.")
  }

  async stage(tenantId: unknown, method: unknown, services: unknown): Promise<WizardSignInResponse> {
    if (!isGuid(tenantId) || (method !== "graphCli" && method !== "tenuvaultApp")) {
      return wizardFailure(new ConnectionSwitchError("invalid_request", "Enter a valid tenant ID."))
    }
    const tenant = tenantId.toLowerCase()
    if (this.busy || this.host.connected(tenant)) return wizardFailure(new ConnectionSwitchError("conflict", "This tenant is already connected or signing in."))
    this.busy = true
    try {
      const choice = method === "tenuvaultApp" ? wizardChoice(services) : undefined
      await this.requireMethod(method)
      const staged = await this.host.stage(tenant, method, choice)
      const clientId = method === "graphCli" ? GRAPH_CLI_CLIENT_ID : TENUVAULT_CLIENT_ID
      if (staged.account.tenantId.toLowerCase() !== tenant) throw new ConnectionSwitchError("wrong_tenant", "Sign in with an account from this tenant.")
      if (staged.account.clientId.toLowerCase() !== clientId) throw new ConnectionSwitchError("wrong_client", "Microsoft returned a sign-in for a different app.")
      if (!staged.idToken) throw new ConnectionSwitchError("no_account", "Microsoft did not return a sign-in proof for this tenant.")
      if (this.host.connected(tenant)) throw new ConnectionSwitchError("conflict", "This tenant was connected during sign-in.")
      if (this.pending && this.pending.staged.account.tenantId !== tenant) await this.discard(this.pending.id)
      await this.cleanup
      try {
        await this.host.checkLicense(staged)
        await this.requireMethod(method)
        if (this.host.connected(tenant)) throw new ConnectionSwitchError("conflict", "This tenant was connected during sign-in.")
      } catch (error) {
        if (!this.pending) await this.release(staged)
        throw error
      }
      const id = randomUUID()
      this.clear()
      this.pending = { id, method, staged, choice }
      this.expiry = setTimeout(() => { void this.discard(id) }, 15 * 60_000)
      this.expiry.unref()
      const { homeAccountId: _, ...account } = staged.account
      const scopes = method === "graphCli" ? staged.graphScopes && new Set(staged.graphScopes) : sharedTokenScopes(staged.accessToken, staged.grantedScopes)
      return { result: { id, account, coverage: graphCliCoverage(scopes, choice) } }
    } catch (error) {
      return wizardFailure(error)
    } finally {
      this.busy = false
    }
  }

  private clear(): void {
    clearTimeout(this.expiry)
    this.pending = undefined
  }

  private release(staged: StagedSignIn): Promise<void> {
    this.cleanup = this.cleanup.then(() => this.host.releaseLicense(staged)).catch(() => undefined)
    return this.cleanup
  }

  discard(id: unknown): Promise<void> {
    const pending = this.pending
    if (!pending || pending.id !== id) return this.cleanup
    this.clear()
    return this.release(pending.staged)
  }

  trialContactProof(tenant: string): string | undefined {
    const staged = this.pending?.staged
    return staged?.account.tenantId === tenant.toLowerCase() && !this.host.connected(tenant) ? staged.idToken : undefined
  }

  async finish(id: unknown, profile: unknown, services: unknown) {
    const pending = this.pending
    if (!pending || pending.id !== id) return wizardFailure(new ConnectionSwitchError("sign_in_required", EXPIRED))
    if (this.busy || this.host.connected(pending.staged.account.tenantId)) return wizardFailure(new ConnectionSwitchError("conflict", "This tenant is already connected or signing in."))
    this.busy = true
    try {
      if (typeof profile !== "string" || profile.length > 64_000) throw new ConnectionSwitchError("invalid_request", "Choose valid backup storage.")
      const choice = pending.choice ?? wizardChoice(services)
      if (pending.method === "graphCli") for (const service of Object.values(choice)) service.access = "backup"
      await this.requireMethod(pending.method)
      await this.host.checkLicense(pending.staged)
      await this.requireMethod(pending.method)
      if (this.pending !== pending) throw new ConnectionSwitchError("sign_in_required", EXPIRED)
      if (this.host.connected(pending.staged.account.tenantId)) throw new ConnectionSwitchError("conflict", "This tenant was connected during sign-in.")
      this.host.enroll(pending, profile, choice)
      this.clear()
      return { result: true as const }
    } catch (error) {
      return wizardFailure(error)
    } finally {
      this.busy = false
    }
  }
}
