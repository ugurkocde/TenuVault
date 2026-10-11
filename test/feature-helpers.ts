import type { GraphCall } from "../src/portal/lib/policies/graph-restore"
import type { FeatureDeps, TenantProfile } from "../src/main/features/deps"
import { TenantRecords } from "../src/main/features/records"
import type { RouteModule } from "../src/main/api/host"
import { NextRequest } from "../src/main/api/next-server-shim"
import type { Plan } from "../src/shared/plans"
import type { OibPack } from "../src/main/oib/source"
import type { BaselineSources } from "../src/main/features/baseline-upgrades/sources"
import { memoryStore } from "./helpers"

export const TENANT_A = "11111111-1111-1111-1111-111111111111"
export const TENANT_B = "22222222-2222-2222-2222-222222222222"
export const TENANT_C = "33333333-3333-3333-3333-333333333333"

/** Frozen OIB packs without network access; every read returns a fresh snapshot. */
export function fakeOibSources(packs: OibPack[]): BaselineSources {
  return {
    runs: () => [],
    releases: async () => ({ releases: packs.map((pack) => ({ platform: pack.platform, tag: pack.reference, commit: pack.commit, reference: pack.reference })) }),
    pack: async (platform, commit) => {
      const pack = packs.find((entry) => entry.platform === platform && entry.commit === commit)
      if (!pack) throw new Error("This OIB pack is not available.")
      return structuredClone(pack)
    },
    workspace: () => ({ policies: [], reference: "", creations: [] }),
  }
}

/**
 * FeatureDeps with in-memory records, fixed plans per tenant and fake Graph. Override any
 * member; `plans` maps tenant IDs to plans (a missing tenant is unlicensed and throws).
 */
export function fakeDeps(options: { plans?: Record<string, Plan>; graph?: (tenantId: string) => GraphCall; now?: () => Date } & Omit<Partial<FeatureDeps>, "graph"> = {}): FeatureDeps & { store: ReturnType<typeof memoryStore>; notifications: string[] } {
  const store = memoryStore()
  const now = options.now ?? (() => new Date("2026-09-30T12:00:00Z"))
  const plans: Record<string, Plan> = Object.fromEntries(Object.entries(options.plans ?? { [TENANT_A]: "pro" }).map(([id, plan]) => [id.toLowerCase(), plan as Plan]))
  const notifications: string[] = []
  const profile = (tenantId: string): TenantProfile | null =>
    plans[tenantId.toLowerCase()] ? { tenantId: tenantId.toLowerCase(), name: `Tenant ${tenantId.slice(0, 4)}`, clientId: "99999999-9999-9999-9999-999999999999", storageAccountName: `tvlocal-${tenantId.toLowerCase()}` } : null
  const deps: FeatureDeps = {
    records: new TenantRecords(store, now),
    plan: async (tenantId) => {
      const plan = plans[tenantId.toLowerCase()]
      if (!plan) throw new Error("This tenant is not licensed.")
      return plan
    },
    sameLicense: () => true,
    tenant: profile,
    tenants: () => Object.keys(plans),
    actor: () => ({ id: "admin@contoso.test", name: "Admin" }),
    graph: async (tenantId) => (options.graph ? options.graph(tenantId) : async () => ({ status: 404, body: {} })),
    api: async () => Response.json({ error: "not faked" }, { status: 501 }),
    externalFetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
    notify: (title, body) => void notifications.push(`${title}: ${body}`),
    now,
  }
  const { plans: _plans, graph: _graph, ...overrides } = options
  return Object.assign(deps, overrides, { records: options.records ?? deps.records, store, notifications })
}

/** Calls a feature route's POST handler and returns the status and parsed JSON. */
export async function call(routes: Record<string, RouteModule>, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const handler = routes[path]?.POST
  if (!handler) throw new Error(`No POST handler for ${path}`)
  const response = await handler(new NextRequest(new Request(`http://tenuvault.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })))
  return { status: response.status, body: await response.json() }
}
