import type { GraphCall } from "../../portal/lib/policies/graph-restore"
import type { Plan } from "../../shared/plans"
import type { OibPrintOptions } from "../../shared/oib/report-html"
import type { PdfBranding } from "../../shared/pdf/theme"
import { DELEGATED_CLIENT_SECRET } from "../../shared/constants"
import type { TenantRecords } from "./records"

/** A connected tenant as the main process knows it. */
export interface TenantProfile {
  tenantId: string
  name: string
  clientId: string
  storageAccountName: string
}

/** The applied change set a rollback recovers; see features/recovery.ts. */
export interface RecoveryScope {
  changeSetId: string
}

/**
 * What the roadmap workflows get from the app. Everything is injected, so each workflow is
 * tested with fakes (see test/helpers/feature-deps.ts) and never reaches for globals.
 */
export interface FeatureDeps {
  records: TenantRecords
  /** The tenant's plan; throws when the tenant is not signed in or not licensed. */
  plan: (tenantId: string) => Promise<Plan>
  /** Whether two tenants are covered by the same license (Pro promotion stays inside it). */
  sameLicense: (a: string, b: string) => boolean
  /** A connected tenant, or null. */
  tenant: (tenantId: string) => TenantProfile | null
  /** IDs of every connected tenant. */
  tenants: () => string[]
  /** The signed-in admin of a tenant, for attributing records; null when unknown. */
  actor: (tenantId: string) => { id: string; name: string } | null
  /**
   * Microsoft Graph (beta) for a tenant with the signed-in admin's delegated token. With
   * `journal`, every non-GET call is recorded in the restore write journal as uncertain until
   * its outcome is known, and a repeated uncertain write is refused until reconciled. With
   * `recovery`, only the change set engine's rollback path: a tenant whose license ended may
   * still be used to roll back the named applied change set (see features/recovery.ts).
   */
  graph: (tenantId: string, options?: { journal?: boolean; recovery?: RecoveryScope }) => Promise<GraphCall>
  /**
   * Calls one of the app's own API routes with the tenant's credentials filled in
   * (see apiBody). With `recovery`, only the pre-change backup of a rollback, under the same
   * recovery authorization as `graph`.
   */
  api: (path: string, tenantId: string, body?: Record<string, unknown>, options?: { recovery?: RecoveryScope }) => Promise<Response>
  /** fetch for customer-configured endpoints (notification webhooks); never Graph or storage. */
  externalFetch: typeof fetch
  /** A system notification on this computer. */
  notify: (title: string, body: string) => void
  /**
   * The Azure watcher's heartbeat.json from the tenant's backup storage account, read with the
   * signed-in admin's storage token. "missing" when there is none (or the storage is local).
   */
  watcherHeartbeat?: (tenantId: string) => Promise<WatcherHeartbeatRead>
  /** Prints report HTML to PDF in a hidden, locked-down window (report-export.ts). */
  printPdf?: (html: string, options: OibPrintOptions) => Promise<Uint8Array>
  /** The PDF branding the tenant's plan allows. */
  pdfBranding?: (tenantId: string) => Promise<PdfBranding | undefined>
  now: () => Date
}

/**
 * The JSON body deps.api sends to one of the app's own routes: the caller's fields, the
 * tenant's credentials, and subscriptionId and resourceGroupName defaulted to "local". The
 * backup routes require those two but storage never uses them, for local or Azure accounts.
 */
export type WatcherHeartbeatRead =
  | { status: "ok"; runAt: string | null; lastError: string | null }
  | { status: "missing" }
  | { status: "error"; message: string }

export function apiBody(tenantId: string, profile: Pick<TenantProfile, "clientId" | "storageAccountName">, body: Record<string, unknown> = {}): Record<string, unknown> {
  return { subscriptionId: "local", resourceGroupName: "local", ...body, tenantId, appId: profile.clientId, clientSecret: DELEGATED_CLIENT_SECRET, storageAccountName: profile.storageAccountName }
}
