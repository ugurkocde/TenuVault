import type { SignedInAccount } from "../../shared/ipc"
import type { StorageChooserDraft } from "../components/StorageChooser"
import { bridge } from "./bridge"

/**
 * Progress through the guided setup, kept in the encrypted app store so it survives a restart:
 * creating the app registration often means leaving TenuVault for PowerShell, or waiting for
 * another administrator. Only identifiers are kept, never a token.
 */
export interface OnboardingDraft {
  /** 0 Connect, 1 Sign in, 2 Storage. The first backup step is never resumed. */
  step: 0 | 1 | 2
  tenant: string
  clientId: string
  displayName: string
  /** The sign-in of a tenant that was not saved yet; resumed only while it is still signed in. */
  account: SignedInAccount | null
  /** Selection survives restarts; access is checked again before Azure can be used. */
  storage?: StorageChooserDraft
}

const KEY = "tenuvault.onboarding.draft"

export const EMPTY_DRAFT: OnboardingDraft = { step: 0, tenant: "", clientId: "", displayName: "", account: null }

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

/** The saved draft, or null when there is none or it cannot be read. */
export function loadOnboardingDraft(): OnboardingDraft | null {
  try {
    const raw = bridge.storage.getItemSync(KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    const step = value.step === 1 || value.step === 2 ? value.step : 0
    const account = validAccount(value.account)
    const storage = value.storage as Partial<StorageChooserDraft> | null
    const draft: OnboardingDraft = {
      step: step === 2 && !account ? 1 : step,
      tenant: text(value.tenant),
      clientId: text(value.clientId),
      displayName: text(value.displayName),
      account,
      ...(account && storage && (storage.kind === "local" || storage.kind === "azure") ? {
        storage: { kind: storage.kind, selectedAccount: text(storage.selectedAccount), verifiedAccount: "" },
      } : {}),
    }
    return isEmptyDraft(draft) ? null : draft
  } catch {
    return null
  }
}

/** Whether a draft holds nothing worth resuming: the Connect step with no input. */
export function isEmptyDraft(draft: OnboardingDraft): boolean {
  return draft.step === 0 && !draft.tenant && !draft.clientId && !draft.displayName && !draft.account
}

let pending: Promise<void> = Promise.resolve()

/** Saves the draft, or removes it when it is empty. Writes run in order; a failure only logs. */
export function saveOnboardingDraft(draft: OnboardingDraft): void {
  const write = () => (isEmptyDraft(draft) ? bridge.storage.removeItem(KEY) : bridge.storage.setItem(KEY, JSON.stringify(draft)))
  pending = pending.then(write).catch((error: unknown) => console.error("Could not save the setup progress:", error))
}

export function clearOnboardingDraft(): void {
  saveOnboardingDraft(EMPTY_DRAFT)
}

/** Whether setup was started on this computer and not finished. */
export function hasOnboardingDraft(): boolean {
  return loadOnboardingDraft() !== null
}
