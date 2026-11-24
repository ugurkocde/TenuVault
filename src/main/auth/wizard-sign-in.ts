import { ORGANIZATIONS, resolveOnboardingTenant } from "./onboarding-tenant"
import { randomUUID } from "node:crypto"
import { DEFAULT_ONBOARDING_CHOICE, ONBOARDING_ENTRA_CHOICE, checkedOnboardingChoice } from "../../shared/services/onboarding"
import { missingForChoice, type PermissionChoice } from "../../shared/services/manifest"
import { chosenBackupCoverage, graphCliCoverage } from "../../shared/services/graph-cli-coverage"
import { missingPackScopes } from "../../shared/services/permission-packs"
import { needsBackupAccess } from "../../shared/services/backup-coverage"
import { isGuid } from "../../shared/security"
import { GRAPH_CLI_DISABLED, TENUVAULT_CLIENT_ID, GRAPH_CLI_CLIENT_ID, type BackupScopeCoverage, type WizardSignInMethod, type WizardSignInResponse } from "../../shared/tenant-connection"
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

function canFinishWithCoverage(coverage: BackupScopeCoverage[]): boolean {
  const selected = coverage.filter(row => row.folders.length)
  return selected.length === 0 || !selected.every(needsBackupAccess)
}

interface PendingSignIn {
  id: string
  method: WizardSignInMethod
  staged: StagedSignIn
  choice?: PermissionChoice
  coverage: BackupScopeCoverage[]
  trialEligible: boolean
}

export class WizardSignIn {
  private pending?: PendingSignIn
  private expiry?: ReturnType<typeof setTimeout>
  private busy = false

  constructor(private readonly host: {
    resolveTenant?: (input: unknown) => Promise<string>
    connected: (tenant: string) => boolean
    enabled: (method: WizardSignInMethod) => Promise<boolean>
    stage: (tenant: string, method: WizardSignInMethod, choice?: PermissionChoice) => Promise<StagedSignIn>
    fetch: typeof fetch
    startTrial: (staged: StagedSignIn) => Promise<void>
    checkLicense: (staged: StagedSignIn) => Promise<void>
    releaseLicense: (staged: StagedSignIn) => Promise<void>
    enroll: (draft: PendingSignIn, profile: string, choice: PermissionChoice) => void
  }) {}

  private async requireMethod(method: WizardSignInMethod) {
    if (!await this.host.enabled(method)) throw new ConnectionSwitchError("unavailable",
      method === "graphCli" ? GRAPH_CLI_DISABLED : "TenuVault app sign-in is currently unavailable.")
  }

  private async organizationName(tenant: string, accessToken: string): Promise<string | undefined> {
    if (!accessToken) return
    try {
      const response = await this.host.fetch("https://graph.microsoft.com/beta/organization?$select=id,displayName", {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return
      const { value } = await response.json() as { value?: { id?: unknown; displayName?: unknown }[] }
      const organization = Array.isArray(value) && value.length === 1 ? value[0] : undefined
      if (typeof organization?.id === "string" && organization.id.toLowerCase() === tenant && typeof organization.displayName === "string") {
        return organization.displayName.trim() || undefined
      }
    } catch {
      // The tenant ID remains available when the staged sign-in cannot read the name.
    }
  }

  async stage(tenantId: unknown, method: unknown, services: unknown): Promise<WizardSignInResponse> {
    if (method !== "graphCli" && method !== "tenuvaultApp") {
      return wizardFailure(new ConnectionSwitchError("invalid_request", "Choose a supported sign-in method."))
    }
    if (this.busy) return wizardFailure(new ConnectionSwitchError("conflict", "This tenant is already connected or signing in."))
    this.busy = true
    try {
      const choice = method === "tenuvaultApp" || services !== undefined ? wizardChoice(services) : undefined
      await this.requireMethod(method)
      const tenant = await (this.host.resolveTenant ?? resolveOnboardingTenant)(tenantId)
      if (tenant !== ORGANIZATIONS && this.host.connected(tenant)) throw new ConnectionSwitchError("conflict", "This tenant is already connected.")
      const staged = await this.host.stage(tenant, method, choice)
      const clientId = method === "graphCli" ? GRAPH_CLI_CLIENT_ID : TENUVAULT_CLIENT_ID
      const actualTenant = staged.account.tenantId.toLowerCase()
      if (!isGuid(actualTenant) || (tenant !== ORGANIZATIONS && actualTenant !== tenant)) throw new ConnectionSwitchError("wrong_tenant", "Sign in with an account from this tenant.")
      if (staged.account.clientId.toLowerCase() !== clientId) throw new ConnectionSwitchError("wrong_client", "Microsoft returned a sign-in for a different app.")
      if (!staged.idToken) throw new ConnectionSwitchError("no_account", "Microsoft did not return a sign-in proof for this tenant.")
      if (this.host.connected(actualTenant)) throw new ConnectionSwitchError("conflict", "This tenant is already connected.")
      const scopes = method === "graphCli" ? staged.graphScopes && new Set(staged.graphScopes) : sharedTokenScopes(staged.accessToken, staged.grantedScopes)
      // Keep the approved subset for later silent requests. The tenant's saved choice still
      // describes everything the admin wants to protect once access is added.
      const verified = method === "tenuvaultApp" && scopes && staged.graphScopes?.filter(scope => missingPackScopes([scope], scopes).length === 0)
      const verifiedScopes = verified || (scopes && [...scopes])
      const coverage = graphCliCoverage(verifiedScopes && new Set(verifiedScopes))
      const trialEligible = method === "graphCli" || canFinishWithCoverage(chosenBackupCoverage(coverage, choice!))
      const [organizationName] = await Promise.all([
        this.organizationName(actualTenant, staged.accessToken),
        trialEligible ? this.host.startTrial(staged) : undefined,
      ])
      await this.requireMethod(method)
      if (this.host.connected(actualTenant)) throw new ConnectionSwitchError("conflict", "This tenant is already connected.")
      const id = randomUUID()
      this.clear()
      this.expiry = setTimeout(() => { void this.discard(id) }, 15 * 60_000)
      this.expiry.unref()
      const { homeAccountId: _, ...account } = staged.account
      this.pending = { id, method, staged: verified ? { ...staged, graphScopes: verified } : staged, choice: method === "tenuvaultApp" ? choice : undefined, coverage, trialEligible }
      const missing = staged.missingOnboardingScopes ?? (method === "graphCli" && scopes && choice ? missingForChoice(choice, { kind: "delegated", permissions: scopes }) : undefined)
      return { result: { id, account, coverage, missing, organizationName, verifiedScopes } }
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

  discard(id: unknown): void {
    if (this.pending?.id === id) this.clear()
  }

  trialContactProof(tenant: string): string | undefined {
    const pending = this.pending
    return pending?.trialEligible && pending.staged.account.tenantId === tenant.toLowerCase() && !this.host.connected(tenant) ? pending.staged.idToken : undefined
  }

  async finish(id: unknown, profile: unknown, services: unknown) {
    const pending = this.pending
    if (!pending || pending.id !== id) return wizardFailure(new ConnectionSwitchError("sign_in_required", EXPIRED))
    if (this.busy || this.host.connected(pending.staged.account.tenantId)) return wizardFailure(new ConnectionSwitchError("conflict", "This tenant is already connected or signing in."))
    this.busy = true
    let checkedLicense = false
    try {
      if (typeof profile !== "string" || profile.length > 64_000) throw new ConnectionSwitchError("invalid_request", "Choose valid backup storage.")
      // A staged public sign-in can toggle the standard Entra backup selection. Restore
      // permissions and opt-in inventory still require their own verified connection flow.
      let choice = pending.method === "tenuvaultApp" ? pending.choice! : wizardChoice(services)
      if (pending.method === "tenuvaultApp" && choice.intune?.access === "backup") {
        const requested = wizardChoice(services)
        const standard = Object.entries(requested).every(([id, service]) =>
          (id === "intune" || id === "conditionalAccess" || id === "entra") && service.access === "backup" && !service.areas?.length)
        if (standard && requested.intune && Boolean(requested.entra) === Boolean(requested.conditionalAccess)) {
          choice = structuredClone(requested.entra ? ONBOARDING_ENTRA_CHOICE : DEFAULT_ONBOARDING_CHOICE)
        }
      }
      const coverage = chosenBackupCoverage(pending.coverage, choice)
      if (!canFinishWithCoverage(coverage)) {
        throw new ConnectionSwitchError("AADSTS65001", "Check backup access before continuing.")
      }
      if (pending.method === "graphCli") for (const service of Object.values(choice)) service.access = "backup"
      await this.requireMethod(pending.method)
      if (this.pending !== pending) throw new ConnectionSwitchError("sign_in_required", EXPIRED)
      checkedLicense = true
      await this.host.checkLicense(pending.staged)
      await this.requireMethod(pending.method)
      if (this.pending !== pending) throw new ConnectionSwitchError("sign_in_required", EXPIRED)
      if (this.host.connected(pending.staged.account.tenantId)) throw new ConnectionSwitchError("conflict", "This tenant was connected during sign-in.")
      this.host.enroll(pending, profile, choice)
      this.clear()
      return { result: true as const }
    } catch (error) {
      if (checkedLicense && !this.host.connected(pending.staged.account.tenantId)) {
        await this.host.releaseLicense(pending.staged).catch(() => undefined)
      }
      return wizardFailure(error)
    } finally {
      this.busy = false
    }
  }
}
