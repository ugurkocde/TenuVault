import type { RouteModule } from "../../api/host"
import type { Item } from "../../../shared/intune/registry"
import { isGraphId } from "../../../shared/security"
import { OIB_PLATFORMS, type OibPlatform } from "../../../shared/oib/types"
import type { SignalProvider } from "../contracts"
import type { FeatureDeps } from "../deps"
import { AuditEventType } from "../../../portal/lib/audit/types"
import { recordGovernanceAudit } from "../governance-audit"
import { featureRoute, FeatureError, optionalText, text, type Body } from "../route"
import { listChangeSets } from "../change-sets/engine"
import { changeSetActions } from "../baseline-upgrades/change-actions"
import { defaultSources, type BaselineSources } from "../baseline-upgrades/sources"
import { policyMatchKey } from "../baseline-upgrades/merge"
import { diffVersions, type Overlay, type OverlayException } from "./model"
import {
  adoptionStatus,
  assessAdoption,
  configureAdoption,
  createCustomization,
  getAdoption,
  getStandardVersion,
  listAdoptions,
  listCustomizations,
  listStandardVersions,
  planAdoption,
  previewAdoption,
  publishVersion,
  retireCustomization,
  reviseCustomization,
  standardSignals,
  startAdoption,
  syncAdoption,
  type VersionInput,
} from "./service"

const MAX_INSTANCE = 200_000

const idOf = (body: Body, key = "id"): string => {
  const id = text(body, key, 100)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FeatureError(`Invalid ${key}`)
  return id
}

const objects = (value: unknown, max: number, what: string): Record<string, unknown>[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) throw new FeatureError(`Invalid ${what}`)
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new FeatureError(`Invalid ${what}`)
    return entry as Record<string, unknown>
  })
}

const shortText = (value: unknown, what: string, max = 500): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new FeatureError(`${what} is required`)
  return value.trim()
}

const plain = <T extends { history?: unknown }>(record: T) => {
  const { history: _history, ...rest } = record
  return rest
}

function parseInstance(value: unknown): Item {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeatureError("An overlay setting needs a setting instance.")
  const instance = value as Item
  if (typeof instance.settingDefinitionId !== "string" || typeof instance["@odata.type"] !== "string") throw new FeatureError("An overlay setting instance needs a settingDefinitionId and @odata.type.")
  if (JSON.stringify(instance).length > MAX_INSTANCE) throw new FeatureError("An overlay setting is too large.")
  return structuredClone(instance)
}

/** Overlay, parameters and exceptions from untrusted input; each part is validated on its own. */
function parseOverlay(value: unknown): Overlay {
  const body = (value ?? {}) as Record<string, unknown>
  if (typeof body !== "object" || Array.isArray(body)) throw new FeatureError("Invalid overlay")
  const exceptions: OverlayException[] = objects(body.exceptions, 500, "exceptions").map((entry) => {
    const expiresAt = shortText(entry.expiresAt, "An exception expiry", 40)
    if (!Number.isFinite(Date.parse(expiresAt))) throw new FeatureError("An exception expiry must be a date.")
    if (entry.status !== "approved" && entry.status !== "revoked") throw new FeatureError("An exception is approved or revoked.")
    return { policyKey: shortText(entry.policyKey, "An exception policy"), settingDefinitionId: shortText(entry.settingDefinitionId, "An exception setting"), reason: shortText(entry.reason, "An exception reason", 2000), approver: shortText(entry.approver, "An exception approver", 200), expiresAt, status: entry.status }
  })
  return {
    settings: objects(body.settings, 500, "overlay settings").map((entry) => ({ policyKey: shortText(entry.policyKey, "An overlay policy"), instance: parseInstance(entry.instance) })),
    removals: objects(body.removals, 500, "overlay removals").map((entry) => ({ policyKey: shortText(entry.policyKey, "A removal policy"), settingDefinitionId: shortText(entry.settingDefinitionId, "A removal setting") })),
    exceptions,
  }
}

function parseParameters(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 50) throw new FeatureError("Invalid parameters")
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || (entry !== null && typeof entry !== "string" && typeof entry !== "number") || (typeof entry === "string" && entry.length > 1000)) throw new FeatureError(`Invalid parameter ${name.slice(0, 40)}`)
  }
  return value as Record<string, unknown>
}

/** Standard content from an OpenIntuneBaseline commit (the source the OpenIntuneBaseline section resolved) or from Settings Catalog exports. */
async function versionInput(body: Body, sources: BaselineSources): Promise<VersionInput> {
  const source = (body.source ?? {}) as Record<string, unknown>
  const bindings = objects(body.bindings, 200, "bindings").map((entry) => ({ policyKey: shortText(entry.policyKey, "A binding policy"), settingDefinitionId: shortText(entry.settingDefinitionId, "A binding setting"), parameter: shortText(entry.parameter, "A binding parameter", 40) }))
  const base = { name: text(body, "name", 200), changeNotes: text(body, "changeNotes", 4000), parameters: body.parameters, bindings }
  if (source.type === "oib") {
    const platform = source.platform
    if (typeof platform !== "string" || !Object.hasOwn(OIB_PLATFORMS, platform)) throw new FeatureError("Choose an OIB platform.")
    if (typeof source.commit !== "string" || !/^[0-9a-f]{40}$/.test(source.commit)) throw new FeatureError("The OpenIntuneBaseline version is missing. Reload the latest version and try again.")
    const names = Array.isArray(source.policyNames) ? new Set(source.policyNames.slice(0, 200).map((name) => policyMatchKey(String(name)))) : null
    let pack
    try {
      pack = await sources.pack(platform as OibPlatform, source.commit)
    } catch (error) {
      throw new FeatureError(`The release could not be loaded. ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    const items = pack.items.filter((item) => item.folder === "ConfigurationPolicies" && (!names || names.has(policyMatchKey(item.name))))
    return { ...base, source: { type: "oib", reference: pack.reference, commit: pack.commit, platform: platform as OibPlatform }, policies: items.map((item) => item.snapshot) }
  }
  if (source.type === "manual") {
    if (JSON.stringify(body.policies ?? null).length > 8_000_000) throw new FeatureError("The policies exceed 8 MB.")
    return { ...base, source: { type: "manual", reference: text(source as Body, "reference", 300), commit: null, platform: null }, policies: body.policies }
  }
  throw new FeatureError("Choose the source of the standard: an OIB release or Settings Catalog exports.")
}

/**
 * /api/standards (#148).
 * - Pro (`customizations`): the organization's documented customizations of its own tenant.
 * - MSP (`standard-...`, goldenStandards): reusable standard versions in the shared scope, and
 *   per customer (the request's tenantId) adoptions with parameters, overlay, exceptions,
 *   preview, change set, review, apply, rollback and assessment.
 * - `portfolio-adoptions` (MSP portfolio): adoption state across the named targetTenants.
 * `list-...`/`get-...` return stored records on every plan.
 */
export function routes(deps: FeatureDeps, sources: BaselineSources = defaultSources): Record<string, RouteModule> {
  return featureRoute("/api/standards", deps, {
    // Stored records, readable on every plan.
    "list-customizations": ({ tenantId }) => ({ customizations: listCustomizations(deps, tenantId).map(plain) }),
    "get-customization": ({ tenantId, body }) => {
      const record = listCustomizations(deps, tenantId).find((entry) => entry.id === idOf(body))
      if (!record) throw new FeatureError("This customization does not exist for this tenant.", 404)
      return { customization: record }
    },
    "list-standards": () => ({ standards: listStandardVersions(deps).map(plain) }),
    "get-standard": ({ body }) => ({ standard: getStandardVersion(deps, idOf(body)) }),
    "list-adoptions": ({ tenantId }) => ({ adoptions: listAdoptions(deps, tenantId).map((adoption) => ({ ...plain(syncAdoption(deps, tenantId, adoption.id)), state: adoptionStatus(deps, getAdoption(deps, tenantId, adoption.id)) })) }),
    "get-adoption": ({ tenantId, body }) => {
      const adoption = syncAdoption(deps, tenantId, idOf(body))
      const changeSets = listChangeSets(deps, tenantId).filter((entry) => entry.origin.workflow === "standard-adoption" && entry.origin.recordId === adoption.id)
      return { adoption, state: adoptionStatus(deps, adoption), changeSets }
    },

    // Organization customizations (Pro).
    "create-customization": async ({ tenantId, body, actor }) => {
      const expiresAt = optionalText(body, "expiresAt", 40)
      if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) throw new FeatureError("An expiry must be a date.")
      const customization = createCustomization(deps, tenantId, {
        title: text(body, "title", 200),
        installId: optionalText(body, "installId", 100),
        baselineReference: optionalText(body, "baselineReference", 300),
        policyName: optionalText(body, "policyName", 300),
        settingKey: text(body, "settingKey", 500),
        value: optionalText(body, "value", 2000),
        reason: text(body, "reason", 2000),
        owner: text(body, "owner", 200),
        expiresAt,
      }, actor)
      await recordGovernanceAudit(deps, tenantId, actor, { eventType: AuditEventType.GOVERNANCE_CUSTOMIZATION_RECORDED, action: "Document customization", resourceId: customization.id, resourceName: customization.title, link: "/portal/governance/customizations", details: { settingKey: customization.settingKey, owner: customization.owner, expiresAt, decision: "created" } })
      return { customization }
    },
    "revise-customization": async ({ tenantId, body, actor }) => {
      const change: { value?: string | null; reason?: string; owner?: string; expiresAt?: string | null } = {}
      if (body.expiresAt !== undefined) {
        const expiresAt = optionalText(body, "expiresAt", 40)
        if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) throw new FeatureError("An expiry must be a date.")
        change.expiresAt = expiresAt
      }
      if (body.value !== undefined) change.value = optionalText(body, "value", 2000)
      if (body.reason !== undefined) change.reason = text(body, "reason", 2000)
      if (body.owner !== undefined) change.owner = text(body, "owner", 200)
      const why = text(body, "why", 2000)
      const customization = reviseCustomization(deps, tenantId, idOf(body), change, why, actor)
      await recordGovernanceAudit(deps, tenantId, actor, { eventType: AuditEventType.GOVERNANCE_CUSTOMIZATION_RECORDED, action: "Revise customization", resourceId: customization.id, resourceName: customization.title, link: "/portal/governance/customizations", details: { settingKey: customization.settingKey, owner: customization.owner, expiresAt: customization.expiresAt ?? null, decision: "revised", note: why } })
      return { customization }
    },
    "retire-customization": async ({ tenantId, body, actor }) => {
      const why = text(body, "why", 2000)
      const customization = retireCustomization(deps, tenantId, idOf(body), why, actor)
      await recordGovernanceAudit(deps, tenantId, actor, { eventType: AuditEventType.GOVERNANCE_CUSTOMIZATION_RETIRED, action: "Retire customization", resourceId: customization.id, resourceName: customization.title, link: "/portal/governance/customizations", details: { settingKey: customization.settingKey, note: why } })
      return { customization }
    },

    // Reusable standards (MSP, shared scope). The tenantId is the MSP's working tenant for plan checks only.
    // Publishes are shared-scope decisions with no customer tenant of their own, so they are
    // kept in the version's own history (actor and change notes) instead of one customer's
    // audit log. Starting an adoption for a customer is audited under that customer below.
    "standard-create": async ({ body, actor }) => ({
      standard: publishVersion(deps, { ...(await versionInput(body, sources)), standardKey: text(body, "standardKey", 41), previousVersionId: null }, deps.tenants(), actor),
    }),
    "standard-publish-version": async ({ body, actor }) => ({
      standard: publishVersion(deps, { ...(await versionInput(body, sources)), standardKey: null, previousVersionId: idOf(body, "previousVersionId") }, deps.tenants(), actor),
    }),
    "get-standard-diff": ({ body }) => ({ diff: diffVersions(getStandardVersion(deps, idOf(body, "fromId")), getStandardVersion(deps, idOf(body, "toId"))) }),

    // Customer adoptions (MSP). The tenantId is the customer tenant.
    "standard-adopt": async ({ tenantId, body, actor }) => {
      const adoption = startAdoption(deps, tenantId, idOf(body, "versionId"), actor)
      await recordGovernanceAudit(deps, tenantId, actor, { eventType: AuditEventType.GOVERNANCE_STANDARD_ADOPTED, action: "Start standard adoption", resourceId: adoption.id, resourceName: adoption.title, link: "/portal/governance/standards", details: { adoptionId: adoption.id } })
      return { adoption }
    },
    "standard-configure": async ({ tenantId, body, actor }) => {
      const change: Parameters<typeof configureAdoption>[3] = {}
      if (body.versionId !== undefined) change.versionId = idOf(body, "versionId")
      if (body.parameters !== undefined) change.parameters = parseParameters(body.parameters)
      if (body.overlay !== undefined) change.overlay = parseOverlay(body.overlay)
      if (body.mappings !== undefined) {
        change.mappings = objects(body.mappings, 200, "mappings").map((entry) => {
          if (entry.objectId !== null && !isGraphId(entry.objectId)) throw new FeatureError("A mapping names a customer policy ID or null to create a new policy.")
          return { policyKey: shortText(entry.policyKey, "A mapping policy"), objectId: entry.objectId as string | null }
        })
      }
      const before = change.overlay ? getAdoption(deps, tenantId, idOf(body)).overlay.exceptions : null
      const adoption = configureAdoption(deps, tenantId, idOf(body), change, actor)
      if (before) {
        const stateOf = (list: Overlay["exceptions"]) => new Map(list.map((entry) => [`${entry.policyKey}:${entry.settingDefinitionId}`, entry.status]))
        const was = stateOf(before)
        const after = stateOf(adoption.overlay.exceptions)
        const decided = [
          ...adoption.overlay.exceptions.filter((entry) => was.get(`${entry.policyKey}:${entry.settingDefinitionId}`) !== entry.status),
          ...before.filter((entry) => !after.has(`${entry.policyKey}:${entry.settingDefinitionId}`)).map((entry) => ({ ...entry, status: "removed" as const })),
        ]
        if (decided.length) {
          await recordGovernanceAudit(deps, tenantId, actor, { eventType: AuditEventType.GOVERNANCE_STANDARD_ADOPTED, action: "Decide standard exceptions", resourceId: adoption.id, resourceName: adoption.title, link: "/portal/governance/standards", details: { adoptionId: adoption.id, decisions: decided.map((entry) => `${entry.policyKey}:${entry.settingDefinitionId}=${entry.status}`).join(", ") } })
        }
      }
      return { adoption }
    },
    "standard-preview": ({ tenantId, body }) => previewAdoption(deps, tenantId, idOf(body)),
    "standard-plan": async ({ tenantId, body, actor }) => planAdoption(deps, tenantId, idOf(body), { acknowledgeMigration: body.acknowledgeMigration === true, title: optionalText(body, "title", 200), ticket: optionalText(body, "ticket", 200) }, actor),
    "standard-assess": async ({ tenantId, body, actor }) => {
      const adoption = await assessAdoption(deps, tenantId, idOf(body), actor)
      return { adoption, state: adoptionStatus(deps, adoption) }
    },
    ...changeSetActions(deps, { prefix: "standard-", workflow: "standard-adoption", exists: (tenantId, id) => void getAdoption(deps, tenantId, id), sync: (tenantId, id) => syncAdoption(deps, tenantId, id) }),

    /** Adoption state of this tenant and the named customer tenants, from stored records only. */
    "portfolio-adoptions": ({ tenantId, targetTenants }) => ({
      tenants: [tenantId, ...targetTenants].map((id) => ({ tenantId: id, name: deps.tenant(id)?.name ?? null, adoptions: listAdoptions(deps, id).map((adoption) => adoptionStatus(deps, adoption)) })),
    }),
  })
}

/** Nothing runs in the background; assessments run when the admin asks. */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}

/** Customer deviation, stale or missing assessments, pending upgrades and unfinished adoptions. */
export const signals: SignalProvider = (deps, tenantId) => standardSignals(deps, tenantId)
