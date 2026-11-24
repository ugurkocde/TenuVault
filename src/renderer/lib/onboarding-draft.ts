import { checkedOnboardingChoice, DEFAULT_ONBOARDING_CHOICE } from "../../shared/services/onboarding"
import type { PermissionChoice } from "../../shared/services/manifest"
import type { SignedInAccount } from "../../shared/ipc"
import { bridge } from "./bridge"

/**
 * Progress through the guided setup, kept in the encrypted app store so it survives a restart:
 * creating the app registration often means leaving TenuVault for PowerShell, or waiting for
 * another administrator. Only identifiers are kept, never a token.
 */
export interface OnboardingDraft {
  /** The first backup and staged public sign-ins are never resumed. */
  step: -2 | -1 | 0 | 1 | 2 | 4
  services?: PermissionChoice
  tenant: string
  clientId: string
  displayName: string
  /** The sign-in of a tenant that was not saved yet; resumed only while it is still signed in. */
  account: SignedInAccount | null
  /** A saved choice could not be read, and the service step's Continue has not confirmed a new one yet. */
  reconfirm?: boolean
}

const KEY = "tenuvault.onboarding.draft"

export const EMPTY_DRAFT: OnboardingDraft = { step: -1, tenant: "", clientId: "", displayName: "", account: null }

const text = (value: unknown, max = 256) => (typeof value === "string" ? value.slice(0, max) : "")

function validAccount(value: unknown): SignedInAccount | null {
  if (!value || typeof value !== "object") return null
  const account = value as Record<string, unknown>
  if (typeof account.tenantId !== "string" || typeof account.clientId !== "string" || typeof account.username !== "string") return null
  return {
    tenantId: account.tenantId,
    clientId: account.clientId,
    username: account.username,
    ...(typeof account.name === "string" ? { name: account.name } : {}),
  }
}

/** How long the sign-in of an unfinished setup is kept through restarts, counted from that sign-in. */
export const PENDING_SIGN_IN_MAX_AGE_MS = 3 * 86_400_000

/**
 * The draft's sign-in, while it is recent. A draft without its time (saved by an older version) has
 * none, and neither has one dated in the future, such as after the clock was set back.
 */
function recentAccount(value: Record<string, unknown>, now = Date.now()): SignedInAccount | null {
  const account = validAccount(value.account)
  const signedInAt = typeof value.signedInAt === "number" ? value.signedInAt : 0
  return account && signedInAt <= now && now - signedInAt < PENDING_SIGN_IN_MAX_AGE_MS ? account : null
}

/** The saved draft, or null when there is none or it cannot be read. An expired sign-in is left out. */
export function loadOnboardingDraft(): OnboardingDraft | null {
  try {
    const raw = bridge.storage.getItemSync(KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    let step: OnboardingDraft["step"] = value.step === -2 || value.step === -1 || value.step === 1 || value.step === 2 || value.step === 4 ? value.step : 0
    let services = DEFAULT_ONBOARDING_CHOICE
    let reconfirm = value.reconfirm === true
    if (Object.hasOwn(value, "services")) {
      try { services = checkedOnboardingChoice(value.services) } catch {
        // A broken choice must never silently approve the default write permissions.
        services = {}
        reconfirm = true
      }
    }
    // Older drafts can contain restore access and onboarding opt-ins. Keep only the service choices.
    const backupOnly: PermissionChoice = {}
    for (const id of ["defender", "entra", "intune"] as const) {
      if (services[id] || (id === "entra" && services.conditionalAccess)) backupOnly[id] = { access: "backup" }
    }
    if (backupOnly.entra) backupOnly.conditionalAccess = { access: "backup" }
    services = backupOnly
    // A choice that still has to be confirmed stays on the service step, even after a valid pick was saved.
    if (reconfirm || !Object.keys(services).length) step = -1
    const account = recentAccount(value)
    const draft: OnboardingDraft = {
      step: (step === 2 || step === 4) && !account ? 1 : step,
      tenant: text(value.tenant),
      clientId: text(value.clientId),
      displayName: text(value.displayName),
      account,
      services,
      ...(reconfirm ? { reconfirm } : {}),
    }
    return isEmptyDraft(draft) ? null : draft
  } catch {
    return null
  }
}

/**
 * The tenant an unfinished setup signed in to, while its sign-in is recent. Startup cleanup leaves
 * that sign-in alone so the setup can resume; an abandoned one is released after a few days.
 */
export function pendingSignInTenant(now = Date.now()): string | null {
  try {
    const raw = bridge.storage.getItemSync(KEY)
    if (!raw) return null
    return recentAccount(JSON.parse(raw) as Record<string, unknown>, now)?.tenantId.toLowerCase() ?? null
  } catch {
    return null
  }
}

/** Whether a draft holds nothing worth resuming: the Connect step with no input. */
export function isEmptyDraft(draft: OnboardingDraft): boolean {
  return draft.step === -1 && !draft.reconfirm && (!draft.services || !Object.keys(draft.services).length) && !draft.tenant && !draft.clientId && !draft.displayName && !draft.account
}

let pending: Promise<void> = Promise.resolve()

/**
 * When the stored draft's sign-in to this tenant was first saved, so saving again never extends it,
 * also once it expired. A new sign-in always follows a draft saved without an account, so it starts
 * a new time.
 */
function signedInAt(tenantId: string): number {
  try {
    const value = JSON.parse(bridge.storage.getItemSync(KEY) ?? "null") as Record<string, unknown> | null
    const stored = value && validAccount(value.account)
    if (stored && stored.tenantId.toLowerCase() === tenantId.toLowerCase() && typeof value.signedInAt === "number") return value.signedInAt
  } catch { /* A fresh time below. */ }
  return Date.now()
}

/** Saves the draft, or removes it when it is empty. Writes run in order; a failure only logs. */
export function saveOnboardingDraft(draft: OnboardingDraft): void {
  const write = () => (isEmptyDraft(draft)
    ? bridge.storage.removeItem(KEY)
    : bridge.storage.setItem(KEY, JSON.stringify(draft.account ? { ...draft, signedInAt: signedInAt(draft.account.tenantId) } : draft)))
  pending = pending.then(write).catch((error: unknown) => console.error("Could not save the setup progress:", error))
}

export function clearOnboardingDraft(): void {
  saveOnboardingDraft(EMPTY_DRAFT)
}

/** Whether setup was started on this computer and not finished. */
export function hasOnboardingDraft(): boolean {
  return loadOnboardingDraft() !== null
}
