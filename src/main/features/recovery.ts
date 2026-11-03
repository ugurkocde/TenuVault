import { AsyncLocalStorage } from "node:async_hooks"
import type { GraphCall } from "../../portal/lib/policies/graph-restore"
import { graphCaller } from "../../portal/lib/policies/graph-restore"
import { INTERNAL_API_ORIGIN } from "../../shared/constants"
import type { Plan } from "../../shared/plans"
import type { ChangeSetRecord } from "./change-sets/model"
import { apiBody, type FeatureDeps, type RecoveryScope, type TenantProfile } from "./deps"
import { DOMAINS } from "./domains"
import type { TenantRecords } from "./records"

/**
 * Recovery authorization: rolling back a change set that was applied while the tenant was
 * licensed must stay possible after the license ended, also for a tenant that the Community
 * plan no longer covers (an expired MSP license leaves every tenant but the Community one
 * unusable). Rollback writes the captured pre-change state back, never new content.
 *
 * Only the change set engine asks for it, and only for a rollback: previewing or creating the
 * rollback of an applied change set, and reviewing, approving and applying a change set of kind
 * "rollback". It covers exactly two things: acquiring the Graph client, and the pre-change
 * backup the apply requires. The backup runs through the app's own routes and the fetch bridge,
 * so the authorization is carried as a request-scoped async context that only `featureAccess`
 * enters, for the named tenant and the backup paths below. Requests from the renderer, other
 * tenants and other work never run in it. The tenant must still be connected, not removed and
 * signed in; review, approval, lineage and integrity checks are the engine's as for any change.
 */
const recoveryContext = new AsyncLocalStorage<string>()

/** The app routes a recovery may call: start the pre-change backup, poll it and check its contents. */
export const RECOVERY_API_PATHS: ReadonlySet<string> = new Set(["/api/backup/start", "/api/backup/status", "/api/list-backup-contents"])

/** Whether the current request runs inside a recovery of this tenant. */
export function inRecovery(tenantId: string): boolean {
  return recoveryContext.getStore() === tenantId.toLowerCase()
}

/** Whether the scope names a change set of the tenant that was applied and is not itself a rollback. */
export function recoverable(records: TenantRecords, tenantId: string, scope: RecoveryScope): boolean {
  const record = records.get<ChangeSetRecord>(DOMAINS.changeSets, tenantId.toLowerCase(), scope.changeSetId)
  return !!record && record.kind !== "rollback" && !!record.preChange
}

export interface RecoveryLicense {
  requireEntitlement: (tenantId: string) => Promise<Plan>
  /** Like requireEntitlement, but resolves null instead of refusing a tenant whose license ended. */
  requireRecovery: (tenantId: string) => Promise<Plan | null>
}

/**
 * The license check of the fetch bridge and the backup engine: requireEntitlement, except for
 * the tenant of a recovery in progress in this async context.
 */
export function tenantAuthorizer(license: RecoveryLicense): (tenantId: string) => Promise<Plan | null> {
  return (tenantId) => (inRecovery(tenantId) ? license.requireRecovery(tenantId) : license.requireEntitlement(tenantId))
}

/** A request to a recovery backup path for the tenant of the recovery in progress; the plan guard lets it pass. */
export async function isRecoveryBackupRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST" || !RECOVERY_API_PATHS.has(new URL(request.url).pathname.replace(/\/$/, ""))) return false
  const body = (await request.clone().json().catch(() => null)) as { tenantId?: unknown; bulk?: unknown; targetTenants?: unknown } | null
  // One tenant only: a bulk request keeps the plan check.
  return typeof body?.tenantId === "string" && body.bulk === undefined && body.targetTenants === undefined && inRecovery(body.tenantId)
}

/** The API host's plan guard: the backup requests of a recovery in progress pass, every other request goes to `guard`. */
export function withRecoveryBackups(guard: (request: Request) => Promise<Response | null>): (request: Request) => Promise<Response | null> {
  return async (request) => ((await isRecoveryBackupRequest(request)) ? null : guard(request))
}

/**
 * The license side of the backup engine and the fetch bridge (src/main/index.ts): every token
 * request and local backup access is authorized with `authorizeTenant`, and a recovery backup
 * keeps everything (retention 0), so a rollback after a plan ended never deletes older backups.
 */
export function backupAuthorization(options: {
  license: RecoveryLicense
  tokenFor: (tenantId: string, clientId: string, scope: string) => Promise<{ accessToken: string }>
  retentionDays: (tenantId: string) => number
}) {
  const authorizeTenant = tenantAuthorizer(options.license)
  return {
    authorizeTenant,
    getToken: async (tenantId: string, clientId: string, scope: string): Promise<string> => {
      await authorizeTenant(tenantId)
      return (await options.tokenFor(tenantId, clientId, scope)).accessToken
    },
    retentionDays: (tenantId: string): number => (inRecovery(tenantId) ? 0 : options.retentionDays(tenantId)),
  }
}

function refuse(): never {
  throw new Error("Recovery is only available for the rollback of an applied change set of this tenant.")
}

export interface FeatureAccessOptions {
  license: RecoveryLicense
  records: TenantRecords
  /** The app registration the tenant is signed in with; throws when it is not signed in. */
  signedInClient: (tenantId: string) => string
  tokenFor: (tenantId: string, clientId: string, scope: string, forceRefresh?: boolean) => Promise<{ accessToken: string }>
  fetch: typeof fetch
  dispatch: (request: Request) => Promise<Response>
  tenantProfile: (tenantId: string) => Pick<TenantProfile, "clientId" | "storageAccountName"> | null
}

const GRAPH_SCOPE = "https://graph.microsoft.com/.default"

/** The Graph and app route dependencies of the roadmap workflows, with recovery authorization. */
export function featureAccess(options: FeatureAccessOptions): Pick<FeatureDeps, "graph" | "api"> {
  return {
    graph: async (tenantId, { journal, recovery } = {}): Promise<GraphCall> => {
      if (recovery) {
        if (!recoverable(options.records, tenantId, recovery)) refuse()
        await options.license.requireRecovery(tenantId)
      } else {
        await options.license.requireEntitlement(tenantId)
      }
      const clientId = options.signedInClient(tenantId)
      const token = await options.tokenFor(tenantId, clientId, GRAPH_SCOPE)
      return graphCaller(token.accessToken, options.fetch, {
        tenant: journal ? tenantId.toLowerCase() : undefined,
        refreshToken: async () => (await options.tokenFor(tenantId, clientId, GRAPH_SCOPE, true)).accessToken,
      })
    },
    api: async (path, tenantId, body = {}, { recovery } = {}) => {
      const profile = options.tenantProfile(tenantId)
      if (!profile) return Response.json({ error: "This tenant is no longer connected." }, { status: 404 })
      const request = () => options.dispatch(new Request(`${INTERNAL_API_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(apiBody(tenantId, profile, body)),
      }))
      if (!recovery) return request()
      if (!RECOVERY_API_PATHS.has(path) || !recoverable(options.records, tenantId, recovery)) refuse()
      return recoveryContext.run(tenantId.toLowerCase(), request)
    },
  }
}
