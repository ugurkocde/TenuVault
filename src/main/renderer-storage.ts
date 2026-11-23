/** Largest key the renderer may use in the encrypted app store. */
export const RENDERER_STORAGE_KEY_LIMIT = 256

/** Largest value the renderer may keep in the encrypted app store, matching the 4 MB saved drift results limit. */
export const RENDERER_STORAGE_VALUE_LIMIT = 4_000_000

/** Checks a renderer storage key before it reaches the encrypted app store. Throws on anything else. */
export function rendererStorageKey(key: unknown): string {
  if (typeof key !== "string" || !key || key.length > RENDERER_STORAGE_KEY_LIMIT) throw new Error("Invalid storage key.")
  return key
}

/** Checks a renderer storage value before it reaches the encrypted app store. Throws on anything else. */
export function rendererStorageValue(value: unknown): string {
  if (typeof value !== "string" || value.length > RENDERER_STORAGE_VALUE_LIMIT) throw new Error("The value is too large to save.")
  return value
}
import type { TenantStorageResources } from "../shared/ipc"
import { localStorageAccountName } from "../shared/constants"
import { isLocalAccount } from "./storage/blob-emulator"


type TenantProfile = {
  credentials?: { tenantId?: string; appId?: string }
  resources?: TenantStorageResources
  previousAzureStorage?: TenantStorageResources
}

function profiles(raw: string | null | undefined): TenantProfile[] {
  try {
    const value = JSON.parse(raw ?? "[]")
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const tenantOf = (profile: TenantProfile) => typeof profile?.credentials?.tenantId === "string" ? profile.credentials.tenantId.toLowerCase() : undefined
const accountOf = (profile: TenantProfile | undefined) => typeof profile?.resources?.storageAccountName === "string" ? profile.resources.storageAccountName.toLowerCase() : ""

export function assertTenantStorageUpdates(previous: string | null, next: string, enrolled: (tenant: string, account: string) => boolean) {
  const old = new Map(profiles(previous).map(profile => [tenantOf(profile), accountOf(profile)]))
  for (const profile of profiles(next)) {
    const tenant = tenantOf(profile)
    const account = old.get(tenant)
    if (tenant && account && account !== accountOf(profile) && enrolled(tenant, account)) {
      throw new Error("Use Change storage to move backups that are enrolled in secret omission.")
    }
  }
}

export async function changeTenantAccount(tenant: string, from: string, resources: TenantStorageResources, deps: {
  readProfiles: () => string | null
  writeProfiles: (value: string) => void
  enrolled: (tenant: string, account: string) => boolean
  destinationEnabled: (account: string, clientId: string) => Promise<boolean>
  confirmOff: (account: string) => Promise<boolean>
}): Promise<boolean> {
  const destination = resources?.storageAccountName
  if (typeof destination !== "string" || (destination !== localStorageAccountName(tenant) && !/^[a-z0-9]{3,24}$/.test(destination))) {
    throw new Error("Choose a valid backup storage account.")
  }
  const read = () => {
    const tenants = profiles(deps.readProfiles())
    const profile = tenants.find(item => tenantOf(item) === tenant)
    if (!profile?.credentials?.appId || accountOf(profile) !== from) throw new Error("Backup storage changed while you were editing it. Open Change storage again.")
    return { tenants, profile, clientId: profile.credentials.appId }
  }
  const before = read()
  if (from && from !== destination && deps.enrolled(tenant, from)) {
    const enabled = await deps.destinationEnabled(destination, before.clientId).catch(() => {
      throw new Error("Backup storage was not changed. Verify the omission policy on the destination before switching.")
    })
    if (!enabled && !await deps.confirmOff(destination)) return false
  }
  const { tenants, profile, clientId } = read()
  if (clientId !== before.clientId) throw new Error("The tenant sign-in changed. Open Change storage again.")
  if (from && !isLocalAccount(from)) profile.previousAzureStorage = profile.resources
  profile.resources = resources
  deps.writeProfiles(rendererStorageValue(JSON.stringify(tenants)))
  return true
}
