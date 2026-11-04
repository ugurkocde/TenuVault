import { MODULES, type ConnectionId, type ModuleId } from "../../shared/services/modules"
import type { KeyValueStore } from "../storage/secure-store"

const KEY = "services.modules"

/** One module's setting for a tenant. */
export interface ModuleSetting {
  enabled: boolean
  /** The app registration the module uses; every tenant has one ("default") today. */
  connection: ConnectionId
}

const OPT_IN = new Set(MODULES.filter((module) => module.optIn).map((module) => module.id))

/**
 * Which opt-in service modules each tenant uses. Modules that are not opt-in (Intune) are always on.
 * Stored per tenant so an admin turns a new service on deliberately for each tenant.
 */
export class ModuleSettings {
  constructor(
    private readonly store: KeyValueStore,
    private readonly onChange: () => void = () => undefined,
  ) {}

  /** Every module's setting for the tenant. */
  get(tenantId: string): Record<ModuleId, ModuleSetting> {
    const saved = this.read()[tenantId.toLowerCase()] ?? {}
    return Object.fromEntries(MODULES.map((module) => [module.id, { enabled: !module.optIn || saved[module.id]?.enabled === true, connection: "default" as const }])) as Record<ModuleId, ModuleSetting>
  }

  /** The opt-in modules turned on for the tenant. */
  enabled(tenantId: string): ModuleId[] {
    const settings = this.get(tenantId)
    return MODULES.filter((module) => module.optIn && settings[module.id].enabled).map((module) => module.id)
  }

  set(tenantId: string, id: unknown, enabled: unknown): Record<ModuleId, ModuleSetting> {
    if (typeof id !== "string" || !OPT_IN.has(id as ModuleId) || typeof enabled !== "boolean") throw new Error("Choose a service that can be turned on or off.")
    const all = this.read()
    const key = tenantId.toLowerCase()
    all[key] = { ...all[key], [id]: { enabled, connection: "default" } }
    this.store.set(KEY, JSON.stringify(all))
    this.onChange()
    return this.get(tenantId)
  }

  private read(): Record<string, Partial<Record<ModuleId, ModuleSetting>>> {
    try {
      const parsed: unknown = JSON.parse(this.store.get(KEY) ?? "{}")
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Partial<Record<ModuleId, ModuleSetting>>>) : {}
    } catch {
      return {}
    }
  }
}
