import { randomUUID } from "node:crypto"
import type { GraphCall } from "../src/portal/lib/policies/graph-restore"
import type { Item } from "../src/shared/intune/registry"
import type { FeatureDeps } from "../src/main/features/deps"

/**
 * A fake Intune tenant for the change-set engine and promotion tests. It answers the
 * Graph calls those workflows make, with the response shapes verified against Microsoft Graph
 * beta (collections under `value`, Settings Catalog details with expanded settings and
 * assignments, 404 for missing objects, 403 for groups without Group.Read.All).
 */
export class FakeTenant {
  policies = new Map<string, Item>()
  compliance = new Map<string, Item>()
  deviceConfigs = new Map<string, Item>()
  intents = new Map<string, Item>()
  groupPolicies = new Map<string, Item>()
  filters: Item[] = []
  scopeTags: Item[] = [{ id: "0", displayName: "Default", isBuiltIn: true }]
  reusable: Item[] = []
  groups = new Map<string, Item>()
  groupsForbidden = false
  /** Every call, in order; `journaled` tells whether it went through the journaled caller. */
  calls: Array<{ method: string; path: string; body?: Item; journaled: boolean }> = []
  /** Decides per write whether it fails: a status code, "throw" (never sent) or "lost" (applied, response lost). */
  failWrite?: (method: string, path: string, count: number) => number | "throw" | "lost" | undefined
  /** Makes detail reads of policies answer 403 (read-back denied). */
  denyPolicyReads = false
  private writes = 0

  constructor(readonly tenantId: string) {}

  addPolicy(policy: Partial<Item> & { name: string }): Item {
    const id = (policy.id as string | undefined) ?? randomUUID()
    const full: Item = {
      id,
      description: "",
      platforms: "windows10",
      technologies: "mdm",
      roleScopeTagIds: ["0"],
      templateReference: { templateId: "", templateFamily: "none", templateDisplayName: null, templateDisplayVersion: null },
      settings: [setting("device_vendor_msft_policy_config_defender_allowarchivescanning", "device_vendor_msft_policy_config_defender_allowarchivescanning_1")],
      assignments: [],
      lastModifiedDateTime: "2026-09-01T10:00:00Z",
      createdDateTime: "2026-09-01T10:00:00Z",
      settingCount: 1,
      ...policy,
    }
    this.policies.set(id, full)
    return full
  }

  addCompliance(policy: Partial<Item> & { displayName: string }): Item {
    const id = (policy.id as string | undefined) ?? randomUUID()
    const full: Item = {
      id,
      "@odata.type": "#microsoft.graph.windows10CompliancePolicy",
      description: "",
      roleScopeTagIds: ["0"],
      scheduledActionsForRule: [{ id: "rule-1", ruleName: "PasswordRequired", scheduledActionConfigurations: [{ id: "act-1", actionType: "block", gracePeriodHours: 0, notificationTemplateId: "", notificationMessageCCList: [] }] }],
      assignments: [],
      lastModifiedDateTime: "2026-09-01T10:00:00Z",
      createdDateTime: "2026-09-01T10:00:00Z",
      ...policy,
    }
    this.compliance.set(id, full)
    return full
  }

  addDeviceConfig(policy: Partial<Item> & { displayName: string }): Item {
    const id = (policy.id as string | undefined) ?? randomUUID()
    const full: Item = {
      id,
      "@odata.type": "#microsoft.graph.windows10GeneralConfiguration",
      description: "",
      roleScopeTagIds: ["0"],
      assignments: [],
      lastModifiedDateTime: "2026-09-01T10:00:00Z",
      createdDateTime: "2026-09-01T10:00:00Z",
      ...policy,
    }
    this.deviceConfigs.set(id, full)
    return full
  }

  addIntent(policy: Partial<Item> & { displayName: string }): Item {
    const id = (policy.id as string | undefined) ?? randomUUID()
    const full: Item = {
      id,
      description: "",
      roleScopeTagIds: ["0"],
      templateId: "12345678-1234-1234-1234-1234567890ab",
      settings: [{ id: "s1", definitionId: "def-1", valueJson: "{\"value\":true}" }],
      assignments: [],
      lastModifiedDateTime: "2026-09-01T10:00:00Z",
      createdDateTime: "2026-09-01T10:00:00Z",
      ...policy,
    }
    this.intents.set(id, full)
    return full
  }

  addGroupPolicy(policy: Partial<Item> & { displayName: string }): Item {
    const id = (policy.id as string | undefined) ?? randomUUID()
    const full: Item = { id, description: "", roleScopeTagIds: ["0"], definitionValues: [], assignments: [], lastModifiedDateTime: "2026-09-01T10:00:00Z", createdDateTime: "2026-09-01T10:00:00Z", ...policy }
    this.groupPolicies.set(id, full)
    return full
  }

  collectionForPath(path: string): Map<string, Item> | null {
    if (path.startsWith("deviceManagement/deviceCompliancePolicies")) return this.compliance
    if (path.startsWith("deviceManagement/deviceConfigurations")) return this.deviceConfigs
    if (path.startsWith("deviceManagement/intents")) return this.intents
    if (path.startsWith("deviceManagement/groupPolicyConfigurations")) return this.groupPolicies
    if (path.startsWith("deviceManagement/configurationPolicies")) return this.policies
    return null
  }

  writeCount(filter?: (call: { method: string; path: string }) => boolean): number {
    return this.calls.filter((call) => call.method !== "GET" && (!filter || filter(call))).length
  }

  graph(journaled: boolean): GraphCall {
    return async (method, path, body) => {
      this.calls.push({ method, path, body: body ? structuredClone(body) : undefined, journaled })
      if (method !== "GET") {
        this.writes += 1
        const failure = this.failWrite?.(method, path, this.writes)
        if (failure === "throw") throw new Error("socket hang up")
        if (typeof failure === "number") return { status: failure, body: { error: { code: "Fake", message: `Fake failure ${failure}` } } }
        const response = this.write(method, path, body)
        if (failure === "lost") throw new Error("connection reset after send")
        return response
      }
      return this.read(path)
    }
  }

  private read(path: string): { status: number; body: Item } {
    const [route, query = ""] = path.split("?")
    const segments = route!.split("/")
    if (route === "deviceManagement/configurationPolicies") {
      const expand = query.includes("$expand=assignments")
      return { status: 200, body: { value: [...this.policies.values()].map((policy) => ({ id: policy.id ?? null, name: policy.name ?? null, platforms: policy.platforms ?? null, technologies: policy.technologies ?? null, templateReference: policy.templateReference ?? null, lastModifiedDateTime: policy.lastModifiedDateTime ?? null, ...(expand ? { assignments: policy.assignments ?? [] } : {}) })) } }
    }
    if (segments[0] === "deviceManagement" && segments[1] === "configurationPolicies" && segments.length === 3) {
      if (this.denyPolicyReads) return { status: 403, body: { error: { code: "Forbidden", message: "Access denied" } } }
      const policy = this.policies.get(decodeURIComponent(segments[2]!))
      if (!policy) return { status: 404, body: { error: { code: "ResourceNotFound", message: "Not found" } } }
      // Like Graph, a single object read expands assignments as an empty list; they come from {id}/assignments.
      const { assignments: _assignments, ...content } = structuredClone(policy)
      return { status: 200, body: { "@odata.context": "https://graph.microsoft.com/beta/$metadata#deviceManagement/configurationPolicies/$entity", ...content, "settings@odata.context": "x", ...(query.includes("assignments") ? { assignments: [], "assignments@odata.context": "y" } : {}) } }
    }
    if (segments[0] === "deviceManagement" && segments[1] === "configurationPolicies" && segments.length === 4 && segments[3] === "assignments") {
      if (this.denyPolicyReads) return { status: 403, body: { error: { code: "Forbidden", message: "Access denied" } } }
      const policy = this.policies.get(decodeURIComponent(segments[2]!))
      if (!policy) return { status: 404, body: { error: { code: "ResourceNotFound", message: "Not found" } } }
      return { status: 200, body: { value: structuredClone((policy.assignments as Item[] | undefined) ?? []) } }
    }
    const genericCollection = this.collectionForPath(route!)
    if (genericCollection && route !== "deviceManagement/configurationPolicies") {
      const collSegments = route!.split("/")
      if (collSegments.length === 2) return { status: 200, body: { value: [...genericCollection.values()].map((entry) => structuredClone(entry)) } }
      if (collSegments.length === 3) {
        const entry = genericCollection.get(decodeURIComponent(collSegments[2]!))
        if (!entry) return { status: 404, body: { error: { code: "ResourceNotFound", message: "Not found" } } }
        const clone = structuredClone(entry)
        if (route!.startsWith("deviceManagement/intents")) delete clone.settings
        if (route!.startsWith("deviceManagement/intents")) delete clone.assignments
        return { status: 200, body: clone }
      }
      if (collSegments.length === 4) {
        const entry = genericCollection.get(decodeURIComponent(collSegments[2]!))
        if (!entry) return { status: 404, body: { error: { code: "ResourceNotFound", message: "Not found" } } }
        return { status: 200, body: { value: structuredClone((entry[collSegments[3]!] as Item[] | undefined) ?? []) } }
      }
    }
    if (route === "deviceManagement/assignmentFilters") return { status: 200, body: { value: structuredClone(this.filters) } }
    if (route === "deviceManagement/roleScopeTags") return { status: 200, body: { value: structuredClone(this.scopeTags) } }
    if (route === "deviceManagement/reusablePolicySettings") return { status: 200, body: { value: structuredClone(this.reusable) } }
    if (segments[0] === "groups" && segments.length === 2) {
      if (this.groupsForbidden) return { status: 403, body: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } } }
      const group = this.groups.get(decodeURIComponent(segments[1]!).toLowerCase())
      return group ? { status: 200, body: structuredClone(group) } : { status: 404, body: { error: { code: "Request_ResourceNotFound", message: "Not found" } } }
    }
    return { status: 404, body: { error: { code: "NotFound", message: `No fake for ${path}` } } }
  }

  private write(method: string, path: string, body?: Item): { status: number; body: Item } {
    const segments = path.split("?")[0]!.split("/")
    const id = segments[2] ? decodeURIComponent(segments[2]) : undefined
    const collection = this.collectionForPath(path)
    if (method === "POST" && segments[0] === "deviceManagement" && segments[1] === "templates" && segments[3] === "createInstance") {
      const created: Item = { id: randomUUID(), displayName: body?.displayName ?? null, description: body?.description ?? null, roleScopeTagIds: body?.roleScopeTagIds ?? ["0"], templateId: segments[2]!, settings: structuredClone((body?.settingsDelta as Item[] | undefined) ?? []), assignments: [], lastModifiedDateTime: "2026-09-30T12:00:00Z", createdDateTime: "2026-09-30T12:00:00Z" }
      this.intents.set(created.id as string, created)
      return { status: 201, body: created }
    }
    if (method === "POST" && segments.length === 2 && collection) {
      const created: Item = { ...structuredClone(body ?? {}), id: randomUUID(), assignments: [], lastModifiedDateTime: "2026-09-30T12:00:00Z", createdDateTime: "2026-09-30T12:00:00Z" }
      if (Array.isArray(created.settings)) created.settings = (created.settings as Item[]).map((entry, index) => ({ ...entry, id: String(index) }))
      collection.set(created.id as string, created)
      return { status: 201, body: created }
    }
    if ((method === "PUT" || method === "PATCH") && id && collection) {
      const current = collection.get(id)
      if (!current) return { status: 404, body: { error: { code: "ResourceNotFound", message: "Not found" } } }
      collection.set(id, { ...structuredClone(current), ...structuredClone(body ?? {}), id, assignments: current.assignments ?? [], lastModifiedDateTime: "2026-09-30T12:05:00Z" })
      return { status: 204, body: {} }
    }
    if (method === "DELETE" && id && collection) {
      if (!collection.delete(id)) return { status: 404, body: { error: { code: "ResourceNotFound", message: "Not found" } } }
      return { status: 204, body: {} }
    }
    if (method === "POST" && id && segments[3] === "assign" && collection) {
      const current = collection.get(id)
      if (!current) return { status: 404, body: {} }
      const key = Object.keys(body ?? {}).find((entry) => Array.isArray(body?.[entry])) ?? "assignments"
      current.assignments = ((body?.[key] as Item[] | undefined) ?? []).map((assignment) => ({ ...assignment, id: `${id}_${randomUUID()}`, source: "direct", sourceId: id }))
      return { status: 200, body: { value: current.assignments } }
    }
    if (method === "POST" && id && collection && segments[3] === "scheduleActionsForRules") {
      const current = collection.get(id)
      if (!current) return { status: 404, body: {} }
      current.scheduledActionsForRule = structuredClone((body?.deviceComplianceScheduledActionForRules as Item[] | undefined) ?? [])
      return { status: 200, body: {} }
    }
    if (method === "POST" && id && collection && segments[3] === "setScheduledActions") {
      const current = collection.get(id)
      if (!current) return { status: 404, body: {} }
      current.scheduledActionsForRule = structuredClone((body?.scheduledActions as Item[] | undefined) ?? [])
      return { status: 200, body: {} }
    }
    if (method === "POST" && id && collection && segments[3] === "updateSettings") {
      const current = collection.get(id)
      if (!current) return { status: 404, body: {} }
      current.settings = structuredClone((body?.settings as Item[] | undefined) ?? [])
      return { status: 200, body: {} }
    }
    return { status: 400, body: { error: { code: "BadRequest", message: `No fake for ${method} ${path}` } } }
  }
}

export function setting(definitionId: string, value: string): Item {
  return { id: "0", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: definitionId, settingInstanceTemplateReference: null, choiceSettingValue: { settingValueTemplateReference: null, value, children: [] } } }
}

export function stringSetting(definitionId: string, value: string): Item {
  return { settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: definitionId, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationStringSettingValue", value } } }
}

export function referenceSetting(reusableId: string): Item {
  return { id: "1", settingInstance: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance", settingDefinitionId: "device_vendor_msft_policy_privilegemanagement_elevationrules_{elevationrulename}_signaturesource", settingInstanceTemplateReference: null, simpleSettingValue: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationReferenceSettingValue", settingValueTemplateReference: null, value: reusableId, note: null } } }
}

/** metadata.json of a complete backup, as the backup engine writes it. */
export const COMPLETE_BACKUP_METADATA = { Status: "Success", Failures: 0, Scope: { Excluded: [] as string[] }, SkippedTypes: [] as string[], FailedTypes: [] as string[] }

/**
 * Wires fake tenants and a fake backup into FeatureDeps. `backup` decides the backup result,
 * `metadata` the backup's metadata.json (null when it cannot be read); `backups` counts
 * started backups.
 */
export function wire(deps: FeatureDeps, tenants: FakeTenant[], options: { backup?: "ok" | "fail" | "no-start"; metadata?: Record<string, unknown> | null } = {}): { backups: string[] } {
  const backups: string[] = []
  deps.graph = async (tenantId, graphOptions) => {
    await deps.plan(tenantId)
    const tenant = tenants.find((entry) => entry.tenantId.toLowerCase() === tenantId.toLowerCase())
    if (!tenant) throw new Error("Tenant not connected")
    return tenant.graph(graphOptions?.journal === true)
  }
  deps.api = async (path, tenantId, body = {}) => {
    if (path === "/api/audit/log") return Response.json({ success: true })
    if (path === "/api/backup/start") {
      if (options.backup === "no-start") return Response.json({ error: "Storage unavailable" }, { status: 500 })
      backups.push(tenantId.toLowerCase())
      return Response.json({ success: true, jobId: "job-1" })
    }
    if (path === "/api/backup/status") {
      if (options.backup === "fail") return Response.json({ isComplete: true, isSuccessful: false, exception: "Storage write failed" })
      return Response.json({ isComplete: true, isSuccessful: true, backupFolder: "backup-2026-09-30-120000" })
    }
    if (path === "/api/list-backup-contents") {
      if (body.backupId !== "backup-2026-09-30-120000" || options.metadata === null) return Response.json({ error: "Internal server error while listing backup contents" }, { status: 500 })
      return Response.json({ backupId: body.backupId, content: { groups: [], metadata: options.metadata ?? COMPLETE_BACKUP_METADATA } })
    }
    return Response.json({ error: "not faked" }, { status: 501 })
  }
  return { backups }
}
