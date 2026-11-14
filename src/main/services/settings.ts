import { MODULES, MODULE_BY_ID, type AccessLevel, type ConnectionId, type ModuleId, type ServiceSelection } from "../../shared/services/modules"
import type { KeyValueStore } from "../storage/secure-store"

const KEY = "services.modules"

/** One service's setting for a tenant. */
export interface ModuleSetting {
  enabled: boolean
  /** The app registration the service uses; every tenant has one ("default") today. */
  connection: ConnectionId
  /** What TenuVault asks for at setup. The token, never this level, decides whether a backup or restore runs. */
  access: AccessLevel
  /** The service's opt-in areas, each on or off. */
  areas: Record<string, boolean>
}

type Stored = Record<string, unknown>

const record = (value: unknown): Stored | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Stored) : undefined)

/**
 * What each tenant backs up: which services are on, which of their opt-in areas are on, and the access
 * level of each service. Stored per tenant, and per service inside it, so an admin chooses for each
 * tenant and a later version can give a service its own app registration.
 *
 * The stored value is the one earlier versions wrote, with more fields: a service entry they wrote
 * (`enabled` and `connection`) reads as before, and a tenant or service without an entry gets the
 * service's defaults, so Intune stays on and nothing new is turned on by an update. Entries this
 * version does not know are kept when a setting is saved.
 */
export class ModuleSettings {
  constructor(
    private readonly store: KeyValueStore,
    private readonly onChange: () => void = () => undefined,
  ) {}

  /** Every service's setting for the tenant. */
  get(tenantId: string): Record<ModuleId, ModuleSetting> {
    const saved = tenantEntry(this.read(), tenantId).value
    return Object.fromEntries(MODULES.map((module) => {
      const entry = record(saved[module.id]) ?? {}
      const areas = record(entry.areas) ?? {}
      const setting: ModuleSetting = {
        // A service that cannot be switched is always on. One without a readable choice is on only when it is on by default.
        enabled: !module.switchable || (typeof entry.enabled === "boolean" ? entry.enabled : module.defaultOn),
        connection: "default",
        access: entry.access === "backup" || entry.access === "restore" ? entry.access : module.defaultAccess,
        areas: Object.fromEntries(module.areas.filter((area) => area.optIn).map((area) => [area.id, areas[area.id] === true])),
      }
      return [module.id, setting]
    })) as Record<ModuleId, ModuleSetting>
  }

  /** The services that are on for the tenant, each with its opt-in areas that are on: what its backups cover. */
  selection(tenantId: string): ServiceSelection {
    const settings = this.get(tenantId)
    const on = MODULES.filter((module) => settings[module.id].enabled)
    return {
      services: on.map((module) => module.id),
      areas: Object.fromEntries(on.map((module) => [module.id, Object.entries(settings[module.id].areas).filter(([, enabled]) => enabled).map(([area]) => area)])),
    }
  }

  /** Turns a service on or off for the tenant. */
  set(tenantId: string, id: unknown, enabled: unknown): Record<ModuleId, ModuleSetting> {
    const module = typeof id === "string" ? MODULE_BY_ID.get(id as ModuleId) : undefined
    if (!module?.switchable || typeof enabled !== "boolean") throw new Error("Choose a service that can be turned on or off.")
    return this.save(tenantId, module.id, (entry) => ({ ...entry, enabled }))
  }

  /** Sets what TenuVault asks for at setup for a service of the tenant. */
  setAccess(tenantId: string, id: unknown, access: unknown): Record<ModuleId, ModuleSetting> {
    const module = typeof id === "string" ? MODULE_BY_ID.get(id as ModuleId) : undefined
    if (!module || (access !== "backup" && access !== "restore")) throw new Error("Choose a service, and backup or restore as its access.")
    return this.save(tenantId, module.id, (entry) => ({ ...entry, access }))
  }

  /** Turns an opt-in area of a service on or off for the tenant. */
  setArea(tenantId: string, id: unknown, area: unknown, enabled: unknown): Record<ModuleId, ModuleSetting> {
    const module = typeof id === "string" ? MODULE_BY_ID.get(id as ModuleId) : undefined
    const known = module?.areas.find((candidate) => candidate.optIn && candidate.id === area)
    if (!module || !known || typeof enabled !== "boolean") throw new Error("Choose an area that can be turned on or off.")
    return this.save(tenantId, module.id, (entry) => ({ ...entry, areas: { ...record(entry.areas), [known.id]: enabled } }))
  }

  private save(tenantId: string, id: ModuleId, change: (entry: Stored) => Stored): Record<ModuleId, ModuleSetting> {
    const all = this.read()
    const tenant = tenantEntry(all, tenantId)
    // Everything else stored for the tenant and the service stays, including what a later version added.
    all[tenant.key] = { ...tenant.value, [id]: { connection: "default", ...change(record(tenant.value[id]) ?? {}) } }
    this.store.set(KEY, JSON.stringify(all))
    this.onChange()
    return this.get(tenantId)
  }

  private read(): Stored {
    try {
      return record(JSON.parse(this.store.get(KEY) ?? "{}")) ?? {}
    } catch {
      return {}
    }
  }
}

/**
 * The tenant's stored settings and the key they are stored under: the tenant ID in lower case, as
 * every version has written and read it. A key in another case was never read, so it is not read
 * now either; reading it would turn on a service the tenant did not back up before the update.
 */
function tenantEntry(all: Stored, tenantId: string): { key: string; value: Stored } {
  const key = tenantId.toLowerCase()
  return { key, value: Object.hasOwn(all, key) ? (record(all[key]) ?? {}) : {} }
}
