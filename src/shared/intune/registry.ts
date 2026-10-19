/**
 * Every Intune object type TenuVault backs up, and how each one is read and rebuilt.
 *
 * Backup, restore, backup listings and drift detection all read this list, so adding a type here
 * is the only change needed to cover it. All paths are relative to https://graph.microsoft.com/beta/.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Item = { [key: string]: Json }

export type Area =
  | "Device configuration"
  | "Compliance"
  | "Endpoint security"
  | "Scripts and remediations"
  | "Windows updates"
  | "Apps"
  | "App protection and configuration"
  | "Enrollment"
  | "Tenant administration"

/** An extra collection read after the detail GET and stored on the snapshot under `property`. */
export interface Extra {
  property: string
  /** Receives IDs already encoded as URL path segments. */
  path: (id: string) => string
  /** The path returns one object; its `property` is stored instead of a collection. */
  single?: boolean
  /**
   * Read for every entry of this extra, when Graph cannot expand it (max $expand depth is 1) or returns it
   * incomplete. With `property` the collection is stored on the entry; without, the object is merged into it.
   */
  each?: { property?: string; path: (id: string, entryId: string) => string }
}

/**
 * How a snapshot is turned back into Intune objects.
 * - create: POST to the collection (or `createPath`), then follow-up steps.
 * - singleton: the object always exists (built-in defaults); restore updates it in place.
 * - metadata: backed up for reference and drift only; see `limitation`.
 */
export type RestoreKind = "create" | "singleton" | "metadata"

export interface IntuneType {
  folder: string
  label: string
  area: Area
  path: string
  /** Property holding the object's name. */
  nameKey: "displayName" | "name" | "profileName" | "tokenName"
  /** $expand for the detail GET. */
  expand?: string
  /** $select for the detail GET, for types that leave properties out by default. */
  select?: string
  /**
   * Values Graph masks on read, with the request that returns each one in plain text.
   * The backup stores the real value (inside the encrypted backup) so restore can send it again.
   */
  secrets?: (item: Item) => Array<{ path: string; apply: (value: string) => void }>
  /** Extra query for the list GET, for example a $filter. */
  listQuery?: string
  extras?: Extra[]
  /**
   * Assignments are read from {id}/assignments, and earlier versions read them with $expand, which Graph
   * answers with an empty list on single object reads of this type. Backups from those versions hold
   * `assignments: []` whatever was assigned; see assignmentsUnread.
   */
  assignmentsFormerlyExpanded?: true
  /** Returns a reason to leave an item out of backups (built-in objects Intune recreates itself). */
  skip?: (item: Item) => string | undefined
  restore: RestoreKind
  /** Why a type or item cannot be fully restored. */
  limitation?: string
  /** Shown when restoring this type with its assignments has side effects beyond the object itself. */
  assignmentWarning?: string
  /** Decides per item when some items of a type can be restored and others cannot. */
  restorable?: (item: Item) => string | undefined
  /** Assignment action: the key of the /assign body, or "post" to create each assignment separately. */
  assign?: { key: string } | "post"
  /**
   * Graph stores exclusion targets of this type as includes, so restoring one would assign the object to
   * the excluded group. Exclusions are left out of restores and reported.
   */
  exclusionsUnsupported?: boolean
  /** Top-level properties Graph returns but rejects on create or update. */
  readOnly?: string[]
  /** Where to POST a new object when it is not the collection itself. */
  createPath?: (snapshot: Item) => string
  /** Builds the create body from the cleaned snapshot. */
  prepare?: (payload: Item, snapshot: Item) => Item
  /** Requests to run after the object exists, with `{id}` replaced by the new object's ID. */
  after?: (snapshot: Item) => Step[]
  /**
   * Requests that update an existing object in place. Defaults to PATCH with the create body, then `after`.
   * `current` is the live object, read the same way a backup reads it.
   */
  update?: (payload: Item, snapshot: Item, current: Item) => Step[]
}

export interface Step {
  method: "POST" | "PATCH" | "PUT" | "DELETE"
  path: string
  body: Item
  /** A step Intune needs for the object to be complete. Assignment steps are optional. */
  kind: "content" | "assignments"
  /** The step sets its whole list (not adds to it), so it is also safe when replacing an existing object. */
  replacesAll?: boolean
}

/** Server-managed properties Graph returns on most Intune objects. */
export const COMMON_READ_ONLY = [
  "id",
  "createdDateTime",
  "lastModifiedDateTime",
  "modifiedDateTime",
  "version",
  "createdBy",
  "lastModifiedBy",
  "isAssigned",
  "supportsScopeTags",
  "settingCount",
  "creationSource",
  "priorityMetaData",
  "deviceManagementApplicabilityRuleOsEdition",
  "deviceManagementApplicabilityRuleOsVersion",
  "deviceManagementApplicabilityRuleDeviceMode",
  "assignments",
  "groupAssignments",
]

const collection = (value: Json | undefined): Item[] => (Array.isArray(value) ? (value as Item[]) : [])
const str = (value: Json | undefined): string => (typeof value === "string" ? value : "")

/** Keeps an assignment's target and settings, drops the IDs Intune assigns. */
export function cleanAssignment(assignment: Item): Item {
  const copy: Item = {}
  for (const [key, value] of Object.entries(assignment)) {
    // A JSON "__proto__" key would replace the copy's prototype instead of becoming a property.
    if (key === "__proto__" || ["id", "source", "sourceId", "assignmentFilterEvaluationStatusDetails"].includes(key) || key.includes("@odata.") && key !== "@odata.type") continue
    copy[key] = value
  }
  return copy
}

const BRANDING_IMAGES = ["themeColorLogo", "lightBackgroundLogo", "landingPageCustomizedImage"]

const APP_TYPE = (item: Item) => str(item["@odata.type"]).replace("#microsoft.graph.", "")

/** App types Intune can recreate without an installer file. */
export const APPS_WITHOUT_CONTENT = new Set([
  "webApp",
  "windowsWebApp",
  "iosStoreApp",
  "iosVppApp",
  "androidStoreApp",
  "winGetApp",
  "officeSuiteApp",
  "macOSOfficeSuiteApp",
  "macOSMicrosoftEdgeApp",
  "macOSMicrosoftDefenderApp",
  "windowsMicrosoftEdgeApp",
  "microsoftStoreForBusinessApp",
  // Intune downloads catalog app content itself, as long as the catalog package still exists.
  "win32CatalogApp",
])

/** targetApps replaces the whole app list; on update an empty list is sent too, to clear apps added since the backup. */
const MANAGED_APP_TARGETS = (snapshot: Item, always = false): Step[] => {
  const apps = collection(snapshot.apps).map((app) => ({ mobileAppIdentifier: app.mobileAppIdentifier ?? null } as Item))
  return apps.length || always
    ? [{ method: "POST", path: "{collection}/{id}/targetApps", body: { apps, appGroupType: snapshot.appGroupType ?? "selectedPublicApps" }, kind: "content", replacesAll: true }]
    : []
}

const MANAGED_APP_UPDATE = (payload: Item, snapshot: Item): Step[] => [
  { method: "PATCH", path: "{collection}/{id}", body: payload, kind: "content" },
  ...MANAGED_APP_TARGETS(snapshot, true),
]

/** Scheduled actions of a compliance snapshot, without the IDs Graph assigns. */
const COMPLIANCE_RULES = (snapshot: Item): Item[] =>
  collection(snapshot.scheduledActionsForRule).map((rule) => ({
    ruleName: rule.ruleName ?? null,
    scheduledActionConfigurations: collection(rule.scheduledActionConfigurations).map((action) => {
      const copy: Item = { ...action }
      delete copy.id
      return copy
    }),
  }) as Item)

const SET_COMPLIANCE_ACTIONS = (snapshot: Item): Step[] => {
  const scheduledActions = COMPLIANCE_RULES(snapshot)
  return scheduledActions.length
    ? [{ method: "POST", path: "{collection}/{id}/setScheduledActions", body: { scheduledActions }, kind: "content", replacesAll: true }]
    : []
}

const GROUP_POLICY_DEFINITIONS = "https://graph.microsoft.com/beta/deviceManagement/groupPolicyDefinitions"
const definitionId = (value: Item) => str((value.definition as Item | undefined)?.id)

/** An ADMX setting in the shape updateDefinitionValues expects in `added`. */
function groupPolicyValue(value: Item): Item {
  const definition = definitionId(value)
  return {
    enabled: value.enabled ?? false,
    "definition@odata.bind": `${GROUP_POLICY_DEFINITIONS}('${definition}')`,
    presentationValues: collection(value.presentationValues).map((presentation) => {
      const copy: Item = { "@odata.type": presentation["@odata.type"] ?? null }
      for (const key of ["value", "values"]) if (key in presentation) copy[key] = presentation[key] ?? null
      copy["presentation@odata.bind"] = `${GROUP_POLICY_DEFINITIONS}('${definition}')/presentations('${str((presentation.presentation as Item | undefined)?.id)}')`
      return copy
    }),
  }
}

/** What an ADMX setting configures, ignoring IDs and dates, to tell whether it changed. */
const groupPolicyKey = (value: Item) =>
  JSON.stringify({
    enabled: value.enabled ?? false,
    presentations: collection(value.presentationValues)
      .map((presentation) => [str((presentation.presentation as Item | undefined)?.id), presentation.value ?? null, presentation.values ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })

/** Properties Graph takes on create but rejects on PATCH, even unchanged. A change to them needs a new app. */
const APP_CREATE_ONLY: Record<string, string[]> = {
  webApp: ["appUrl"],
  winGetApp: ["manifestHash", "packageIdentifier", "installExperience"],
}

const CATEGORY_REF = (categoryId: string) => `https://graph.microsoft.com/beta/deviceAppManagement/mobileAppCategories/${categoryId}`

/** The only properties Graph lets a PATCH change on AOSP profiles; null is rejected for them. */
const AOSP_PATCHABLE = ["displayName", "description", "wifiSsid", "wifiPassword", "wifiSecurityType", "wifiHidden", "deviceNameTemplate"]

const MASKED_SECRET = "This backup holds a masked OMA-URI value (****). Create a new backup to restore it; restoring would send **** to devices."
const hasMaskedSecret = (item: Item) => collection(item.omaSettings).some((setting) => setting.isEncrypted === true && setting.value === "****")

/** Dependencies and superseded apps an app points to, in the shape updateRelationships expects. */
const appLinks = (app: Item): Item[] =>
  collection(app.relationships)
    .filter((relationship) => relationship.targetType === "child")
    .map((relationship) => {
      const link: Item = { "@odata.type": relationship["@odata.type"] ?? null, targetId: relationship.targetId ?? null }
      for (const key of ["dependencyType", "supersedenceType"]) if (key in relationship) link[key] = relationship[key] ?? null
      return link
    })

const localizedMessages = (snapshot: Item): Item[] =>
  collection(snapshot.localizedNotificationMessages).map((message) => {
    const body: Item = {}
    for (const key of ["locale", "subject", "messageTemplate", "isDefault"]) body[key] = message[key] ?? null
    return body
  })

/** JSON with object keys sorted at every depth, so two reads of one value compare equal. */
const sortedJson = (value: Json | undefined): string =>
  JSON.stringify(value ?? null, (_key, entry: Json) =>
    entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, (entry as Item)[key]])) : entry,
  )
const patch = (body: Item): Step => ({ method: "PATCH", path: "{collection}/{id}", body, kind: "content" })

export const INTUNE_TYPES: IntuneType[] = [
  // Device configuration
  {
    folder: "DeviceConfigurations",
    label: "device configuration profiles",
    area: "Device configuration",
    path: "deviceManagement/deviceConfigurations",
    nameKey: "displayName",
    expand: "assignments",
    secrets: (item) =>
      collection(item.omaSettings)
        .filter((setting) => setting.isEncrypted === true && typeof setting.secretReferenceValueId === "string")
        .map((setting) => ({
          path: `deviceManagement/deviceConfigurations/${encodeURIComponent(str(item.id))}/getOmaSettingPlainTextValue(secretReferenceValueId='${encodeURIComponent(str(setting.secretReferenceValueId).replaceAll("'", "''"))}')`,
          apply: (value: string) => {
            setting.value = value
          },
        })),
    restore: "create",
    restorable: (item) => (hasMaskedSecret(item) ? MASKED_SECRET : undefined),
    // Same guard when replacing in place: PATCH would send **** to devices.
    update: (payload, snapshot) => {
      if (hasMaskedSecret(snapshot)) throw new Error(MASKED_SECRET)
      return [patch(payload)]
    },
    assign: { key: "assignments" },
    // Graph rejects secret references on create; the plain value is sent and Intune encrypts it again.
    prepare: (payload) => {
      for (const setting of collection(payload.omaSettings)) {
        delete setting.secretReferenceValueId
        delete setting.isEncrypted
      }
      return payload
    },
  },
  {
    folder: "ConfigurationPolicies",
    label: "settings catalog and endpoint security policies",
    area: "Device configuration",
    path: "deviceManagement/configurationPolicies",
    nameKey: "name",
    // A single object read with $expand=assignments returns an empty list, so assignments are read separately.
    expand: "settings",
    extras: [{ property: "assignments", path: (id) => `deviceManagement/configurationPolicies/${id}/assignments` }],
    assignmentsFormerlyExpanded: true,
    restore: "create",
    assign: { key: "assignments" },
    prepare: (payload) => {
      delete payload["@odata.type"]
      for (const setting of collection(payload.settings)) delete setting.id
      const template = payload.templateReference as Item | undefined
      if (template) payload.templateReference = { templateId: template.templateId ?? "" }
      return payload
    },
    // PATCH rejects `settings` (navigation property). PUT replaces the policy with its settings and keeps assignments.
    update: (payload) => [{ method: "PUT", path: "{collection}/{id}", body: payload, kind: "content" }],
  },
  {
    folder: "GroupPolicyConfigurations",
    label: "administrative templates",
    area: "Device configuration",
    path: "deviceManagement/groupPolicyConfigurations",
    nameKey: "displayName",
    expand: "assignments",
    extras: [
      {
        property: "definitionValues",
        path: (id) => `deviceManagement/groupPolicyConfigurations/${id}/definitionValues?$expand=definition($select=id,displayName,classType,categoryPath)`,
        each: {
          property: "presentationValues",
          path: (id, valueId) => `deviceManagement/groupPolicyConfigurations/${id}/definitionValues/${valueId}/presentationValues?$expand=presentation($select=id,label)`,
        },
      },
    ],
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["definitionValues", "policyConfigurationIngestionType"],
    after: (snapshot) => {
      const added = collection(snapshot.definitionValues).map(groupPolicyValue)
      return added.length ? [{ method: "POST", path: "{collection}/{id}/updateDefinitionValues", body: { added, updated: [], deletedIds: [] }, kind: "content" }] : []
    },
    // `added` is silently ignored for a definition that already has a value, and `updated` is rejected, so a changed
    // setting is deleted and added again. Deleting and adding in one request is rejected too, hence two requests.
    update: (payload, snapshot, current) => {
      if (!Array.isArray(current.definitionValues)) throw new Error("The current administrative template could not be read, so it cannot be replaced in place.")
      const wanted = new Map(collection(snapshot.definitionValues).map((value) => [definitionId(value), value]))
      const live = new Map(collection(current.definitionValues).map((value) => [definitionId(value), value]))
      const changed = (value: Item, other: Item | undefined) => !other || groupPolicyKey(other) !== groupPolicyKey(value)
      const deletedIds = [...live].filter(([id, value]) => changed(value, wanted.get(id))).map(([, value]) => str(value.id))
      const added = [...wanted].filter(([id, value]) => changed(value, live.get(id))).map(([, value]) => groupPolicyValue(value))
      return [
        patch(payload),
        ...(deletedIds.length ? [{ method: "POST", path: "{collection}/{id}/updateDefinitionValues", body: { added: [], updated: [], deletedIds }, kind: "content" } as Step] : []),
        ...(added.length ? [{ method: "POST", path: "{collection}/{id}/updateDefinitionValues", body: { added, updated: [], deletedIds: [] }, kind: "content" } as Step] : []),
      ]
    },
  },
  {
    folder: "ReusablePolicySettings",
    label: "reusable settings",
    area: "Device configuration",
    path: "deviceManagement/reusablePolicySettings",
    nameKey: "displayName",
    // The default response leaves out the setting itself.
    select: "id,displayName,description,settingDefinitionId,settingInstance,createdDateTime,lastModifiedDateTime,version,referencingConfigurationPolicyCount",
    restore: "create",
    readOnly: ["referencingConfigurationPolicyCount", "version"],
    // PATCH has no route; PUT updates in place.
    update: (payload) => [{ method: "PUT", path: "{collection}/{id}", body: payload, kind: "content" }],
  },
  {
    folder: "HardwareConfigurations",
    label: "BIOS configurations",
    area: "Device configuration",
    path: "deviceManagement/hardwareConfigurations",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "hardwareConfigurationAssignments" },
  },

  // Compliance
  {
    folder: "CompliancePolicies",
    label: "compliance policies",
    area: "Compliance",
    path: "deviceManagement/deviceCompliancePolicies",
    nameKey: "displayName",
    expand: "scheduledActionsForRule($expand=scheduledActionConfigurations),assignments",
    restore: "create",
    assign: { key: "assignments" },
    prepare: (payload) => {
      const rules = collection(payload.scheduledActionsForRule)
      if (!rules.some((rule) => collection(rule.scheduledActionConfigurations).some((action) => action.actionType === "block"))) {
        throw new Error("This compliance snapshot is missing its required block action. Create a new complete backup before restoring.")
      }
      for (const rule of rules) {
        delete rule.id
        for (const action of collection(rule.scheduledActionConfigurations)) delete action.id
      }
      return payload
    },
    // PATCH rejects scheduledActionsForRule (navigation property); scheduleActionsForRules replaces the whole set.
    update: (payload, snapshot) => {
      const body = { ...payload }
      delete body.scheduledActionsForRule
      return [
        patch(body),
        { method: "POST", path: "{collection}/{id}/scheduleActionsForRules", body: { deviceComplianceScheduledActionForRules: COMPLIANCE_RULES(snapshot) }, kind: "content" },
      ]
    },
  },
  {
    folder: "ComplianceSettingsPolicies",
    label: "settings catalog compliance policies",
    area: "Compliance",
    path: "deviceManagement/compliancePolicies",
    nameKey: "name",
    // Graph returns an empty list when scheduledActionsForRule is expanded here, so it is read separately.
    // Assignments too, like the Settings Catalog policies these share their service with.
    expand: "settings",
    extras: [
      {
        property: "scheduledActionsForRule",
        path: (id) => `deviceManagement/compliancePolicies/${id}/scheduledActionsForRule?$expand=scheduledActionConfigurations`,
      },
      { property: "assignments", path: (id) => `deviceManagement/compliancePolicies/${id}/assignments` },
    ],
    assignmentsFormerlyExpanded: true,
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["scheduledActionsForRule"],
    prepare: (payload) => {
      delete payload["@odata.type"]
      for (const setting of collection(payload.settings)) delete setting.id
      return payload
    },
    // Graph ignores scheduledActionsForRule on create and applies a default block with no grace period.
    after: SET_COMPLIANCE_ACTIONS,
    // PATCH rejects `settings`. PUT replaces the policy and keeps assignments, but ignores the actions, so they are set again.
    update: (payload, snapshot) => [{ method: "PUT", path: "{collection}/{id}", body: payload, kind: "content" }, ...SET_COMPLIANCE_ACTIONS(snapshot)],
  },
  {
    folder: "ComplianceScripts",
    label: "compliance scripts",
    area: "Compliance",
    path: "deviceManagement/deviceComplianceScripts",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "deviceHealthScriptAssignments" },
  },

  // Endpoint security (template based profiles and security baselines)
  {
    folder: "EndpointSecurityIntents",
    label: "security baselines and template profiles",
    area: "Endpoint security",
    path: "deviceManagement/intents",
    nameKey: "displayName",
    extras: [
      { property: "settings", path: (id) => `deviceManagement/intents/${id}/settings` },
      { property: "assignments", path: (id) => `deviceManagement/intents/${id}/assignments` },
    ],
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["isMigratingToConfigurationPolicy", "templateId", "settings"],
    createPath: (snapshot) => {
      const id = str(snapshot.templateId)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("The template ID must be a GUID.")
      return `deviceManagement/templates/${id}/createInstance`
    },
    prepare: (payload, snapshot) => ({
      displayName: payload.displayName ?? null,
      description: payload.description ?? null,
      roleScopeTagIds: payload.roleScopeTagIds ?? ["0"],
      settingsDelta: collection(snapshot.settings).map((setting) => {
        const copy = { ...setting }
        delete copy.id
        return copy
      }),
    }),
    // PATCH returns 204 but ignores settingsDelta; updateSettings sets the values.
    update: (payload): Step[] => [
      patch({ displayName: payload.displayName ?? null, description: payload.description ?? null, roleScopeTagIds: payload.roleScopeTagIds ?? ["0"] }),
      { method: "POST", path: "{collection}/{id}/updateSettings", body: { settings: payload.settingsDelta ?? [] }, kind: "content" },
    ],
  },

  // Scripts and remediations
  {
    folder: "PowerShellScripts",
    label: "Windows PowerShell scripts",
    area: "Scripts and remediations",
    path: "deviceManagement/deviceManagementScripts",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "deviceManagementScriptAssignments" },
  },
  {
    folder: "ShellScripts",
    label: "macOS shell scripts",
    area: "Scripts and remediations",
    path: "deviceManagement/deviceShellScripts",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "deviceManagementScriptAssignments" },
  },
  {
    folder: "CustomAttributeScripts",
    label: "macOS custom attributes",
    area: "Scripts and remediations",
    path: "deviceManagement/deviceCustomAttributeShellScripts",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "deviceManagementScriptAssignments" },
    // PATCH rejects the attribute's identity, even unchanged; a renamed attribute can only be restored as a copy.
    update: (payload) => {
      delete payload.displayName
      delete payload.customAttributeName
      delete payload.customAttributeType
      return [patch(payload)]
    },
  },
  {
    folder: "Remediations",
    label: "remediations",
    area: "Scripts and remediations",
    path: "deviceManagement/deviceHealthScripts",
    nameKey: "displayName",
    expand: "assignments",
    skip: (item) => (item.isGlobalScript === true ? "Microsoft provided remediation" : undefined),
    restore: "create",
    assign: { key: "deviceHealthScriptAssignments" },
    readOnly: ["isGlobalScript", "highestAvailableVersion"],
    // deviceHealthScriptType is accepted on create but PATCH rejects it. PATCH also ignores an empty description.
    update: (payload) => {
      delete payload.deviceHealthScriptType
      return [patch(payload)]
    },
  },

  // Windows updates (update rings are device configuration profiles)
  {
    folder: "FeatureUpdateProfiles",
    label: "feature update profiles",
    area: "Windows updates",
    path: "deviceManagement/windowsFeatureUpdateProfiles",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["endOfSupportDate", "deployableContentDisplayName"],
    // PATCH fails whenever installLatestWindows10OnWindows11IneligibleDevice is sent, even unchanged.
    update: (payload) => {
      delete payload.installLatestWindows10OnWindows11IneligibleDevice
      return [patch(payload)]
    },
  },
  {
    folder: "QualityUpdateProfiles",
    label: "expedited quality update profiles",
    area: "Windows updates",
    path: "deviceManagement/windowsQualityUpdateProfiles",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["deployableContentDisplayName", "releaseDateDisplayName"],
  },
  {
    folder: "QualityUpdatePolicies",
    label: "hotpatch quality update policies",
    area: "Windows updates",
    path: "deviceManagement/windowsQualityUpdatePolicies",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "assignments" },
  },
  {
    folder: "DriverUpdateProfiles",
    label: "driver update profiles",
    area: "Windows updates",
    path: "deviceManagement/windowsDriverUpdateProfiles",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["newUpdates", "deviceReporting", "inventorySyncStatus", "driverInventories"],
  },

  // Apps
  {
    folder: "AppCategories",
    label: "app categories",
    area: "Apps",
    path: "deviceAppManagement/mobileAppCategories",
    nameKey: "displayName",
    // Built-in categories carry an empty modification date.
    skip: (item) => (str(item.lastModifiedDateTime).startsWith("0001-01-01") ? "Built-in app category" : undefined),
    restore: "create",
  },
  {
    folder: "Apps",
    label: "apps",
    area: "Apps",
    path: "deviceAppManagement/mobileApps",
    nameKey: "displayName",
    expand: "assignments,categories",
    extras: [{ property: "relationships", path: (id) => `deviceAppManagement/mobileApps/${id}/relationships` }],
    restore: "create",
    restorable: (item) =>
      APPS_WITHOUT_CONTENT.has(APP_TYPE(item)) ? undefined : "Intune does not let apps download installer files. Upload the installer again to restore this app.",
    assign: { key: "mobileAppAssignments" },
    readOnly: [
      "uploadState",
      "publishingState",
      "isAssigned",
      "dependentAppCount",
      "supersedingAppCount",
      "supersededAppCount",
      "committedContentVersion",
      "size",
      "categories",
      "relationships",
      "isFeatured",
    ],
    // Categories and dependency or supersedence links are not accepted on create.
    after: (snapshot) => {
      const categories: Step[] = collection(snapshot.categories).map((category) => ({
        method: "POST",
        path: "{collection}/{id}/categories/$ref",
        body: { "@odata.id": CATEGORY_REF(str(category.id)) },
        kind: "content",
      }))
      const relationships = appLinks(snapshot)
      return relationships.length
        ? [...categories, { method: "POST", path: "{collection}/{id}/updateRelationships", body: { relationships }, kind: "content" }]
        : categories
    },
    // Linking an already linked category fails, so categories are compared with the live app.
    update: (payload, snapshot, current) => {
      for (const key of APP_CREATE_ONLY[APP_TYPE(snapshot)] ?? []) {
        if (JSON.stringify(current[key] ?? null) !== JSON.stringify(snapshot[key] ?? null)) {
          throw new Error(`${key} changed since the backup and Intune cannot change it on an existing app. Delete the app and restore it to recreate it.`)
        }
        delete payload[key]
      }
      const wanted = collection(snapshot.categories).map((category) => str(category.id))
      const present = collection(current.categories).map((category) => str(category.id))
      // updateRelationships sets the app's whole list of dependencies and superseded apps; an empty list clears it.
      const links = appLinks(snapshot)
      const linksChanged = JSON.stringify(links.map((link) => JSON.stringify(link)).sort()) !== JSON.stringify(appLinks(current).map((link) => JSON.stringify(link)).sort())
      return [
        patch(payload),
        ...(linksChanged ? [{ method: "POST", path: "{collection}/{id}/updateRelationships", body: { relationships: links }, kind: "content" } as Step] : []),
        ...wanted.filter((id) => !present.includes(id)).map((id): Step => ({ method: "POST", path: "{collection}/{id}/categories/$ref", body: { "@odata.id": CATEGORY_REF(id) }, kind: "content" })),
        ...present.filter((id) => !wanted.includes(id)).map((id): Step => ({ method: "DELETE", path: `{collection}/{id}/categories/${id}/$ref`, body: {}, kind: "content" })),
      ]
    },
  },
  {
    folder: "AppConfigurationPolicies",
    label: "app configuration policies for managed devices",
    area: "App protection and configuration",
    path: "deviceAppManagement/mobileAppConfigurations",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: { key: "assignments" },
  },
  {
    folder: "ManagedAppConfigurations",
    label: "app configuration policies for managed apps",
    area: "App protection and configuration",
    path: "deviceAppManagement/targetedManagedAppConfigurations",
    nameKey: "displayName",
    expand: "apps,assignments",
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["apps", "deployedAppCount", "isAssigned"],
    after: (snapshot) => MANAGED_APP_TARGETS(snapshot),
    update: MANAGED_APP_UPDATE,
  },
  {
    folder: "AppProtectionIOS",
    label: "iOS app protection policies",
    area: "App protection and configuration",
    path: "deviceAppManagement/iosManagedAppProtections",
    nameKey: "displayName",
    expand: "apps,assignments",
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["apps", "deployedAppCount", "isAssigned"],
    after: (snapshot) => MANAGED_APP_TARGETS(snapshot),
    update: MANAGED_APP_UPDATE,
  },
  {
    folder: "AppProtectionAndroid",
    label: "Android app protection policies",
    area: "App protection and configuration",
    path: "deviceAppManagement/androidManagedAppProtections",
    nameKey: "displayName",
    expand: "apps,assignments",
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["apps", "deployedAppCount", "isAssigned"],
    after: (snapshot) => MANAGED_APP_TARGETS(snapshot),
    update: MANAGED_APP_UPDATE,
  },
  {
    folder: "AppProtectionWindows",
    label: "Windows app protection policies",
    area: "App protection and configuration",
    path: "deviceAppManagement/windowsManagedAppProtections",
    nameKey: "displayName",
    expand: "apps,assignments",
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["apps", "deployedAppCount", "isAssigned"],
    after: (snapshot) => MANAGED_APP_TARGETS(snapshot),
    // PATCH (unlike POST) rejects a null appActionIfUnableToAuthenticateUser.
    update: (payload, snapshot) => {
      if (payload.appActionIfUnableToAuthenticateUser === null) delete payload.appActionIfUnableToAuthenticateUser
      return MANAGED_APP_UPDATE(payload, snapshot)
    },
  },
  {
    folder: "PolicySets",
    label: "policy sets",
    area: "Apps",
    path: "deviceAppManagement/policySets",
    nameKey: "displayName",
    expand: "items,assignments",
    restore: "create",
    readOnly: ["status", "errorCode", "assignments"],
    prepare: (payload) => {
      payload.items = collection(payload.items).map((item) => {
        const copy: Item = { "@odata.type": item["@odata.type"] ?? null, payloadId: item.payloadId ?? null }
        for (const key of ["intent", "settings", "guidedDeploymentTags"]) if (key in item) copy[key] = item[key] ?? null
        return copy
      })
      return payload
    },
    // items cannot be patched; /update adds missing items (by payloadId), updates changed ones and deletes
    // removed ones (both by live item ID), and rejects an empty body.
    update: (payload, _snapshot, current) => {
      const { items, ...body } = payload
      const live = collection(current.items)
      const matched = new Set<Item>()
      const added: Item[] = []
      const updated: Item[] = []
      for (const item of collection(items)) {
        const existing = live.find((entry) => !matched.has(entry) && str(entry.payloadId) === str(item.payloadId))
        if (!existing) {
          added.push(item)
          continue
        }
        matched.add(existing)
        const changed = ["intent", "settings", "guidedDeploymentTags"].some((key) => key in item && sortedJson(item[key]) !== sortedJson(existing[key]))
        if (changed) updated.push({ ...item, id: str(existing.id) })
      }
      const deleted = live.filter((entry) => !matched.has(entry)).map((entry) => str(entry.id))
      return [
        patch(body),
        ...(added.length || updated.length || deleted.length
          ? [{ method: "POST", path: "{collection}/{id}/update", body: { addedPolicySetItems: added, updatedPolicySetItems: updated, deletedPolicySetItems: deleted }, kind: "content" } as Step]
          : []),
      ]
    },
    // Policy sets have no /assign action; /update sets the whole assignment list.
    after: (snapshot) => [
      { method: "POST", path: "{collection}/{id}/update", body: { assignments: collection(snapshot.assignments).map(cleanAssignment) }, kind: "assignments", replacesAll: true },
    ],
  },

  // Enrollment
  {
    folder: "EnrollmentConfigurations",
    label: "enrollment configurations",
    area: "Enrollment",
    path: "deviceManagement/deviceEnrollmentConfigurations",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    restorable: (item) => (item.priority === 0 ? "This is the tenant default. Restore updates it in place." : undefined),
    assign: { key: "enrollmentConfigurationAssignments" },
    exclusionsUnsupported: true,
    readOnly: ["priority", "deviceEnrollmentConfigurationType"],
    // New configurations get the next free priority; put the backed-up order back.
    after: (snapshot) =>
      typeof snapshot.priority === "number" && snapshot.priority > 0
        ? [{ method: "POST", path: "{collection}/{id}/setPriority", body: { priority: snapshot.priority }, kind: "content" }]
        : [],
    // Replacing never reorders the tenant's configurations.
    update: (payload) => [patch(payload)],
  },
  {
    folder: "AutopilotProfiles",
    label: "Windows Autopilot deployment profiles",
    area: "Enrollment",
    path: "deviceManagement/windowsAutopilotDeploymentProfiles",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: "post",
    // language, extractHardwareHash, enableWhiteGlove and outOfBoxExperienceSettings are deprecated and rejected on create.
    readOnly: ["assignedDevices", "managementServiceAppId", "language", "extractHardwareHash", "enableWhiteGlove", "outOfBoxExperienceSettings"],
  },
  {
    folder: "AppleEnrollmentProfiles",
    label: "Apple user enrollment profiles",
    area: "Enrollment",
    path: "deviceManagement/appleUserInitiatedEnrollmentProfiles",
    nameKey: "displayName",
    expand: "assignments",
    restore: "create",
    assign: "post",
    readOnly: ["priority"],
  },
  {
    folder: "AppleAutomatedEnrollment",
    label: "Apple automated device enrollment tokens and profiles",
    area: "Enrollment",
    path: "deviceManagement/depOnboardingSettings",
    nameKey: "tokenName",
    extras: [{ property: "enrollmentProfiles", path: (id) => `deviceManagement/depOnboardingSettings/${id}/enrollmentProfiles` }],
    restore: "metadata",
    limitation: "The Apple token must be uploaded again in Intune. Its enrollment profiles are kept for reference.",
  },
  {
    folder: "AndroidEnrollmentProfiles",
    label: "Android Enterprise enrollment profiles",
    area: "Enrollment",
    path: "deviceManagement/androidDeviceOwnerEnrollmentProfiles",
    nameKey: "displayName",
    restore: "create",
    readOnly: ["tokenValue", "tokenCreationDateTime", "enrolledDeviceCount", "qrCodeContent", "qrCodeImage"],
    // Graph requires a token expiry on create; a restored profile gets a new token valid for 90 days.
    prepare: (payload) => {
      payload.tokenExpirationDateTime = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
      return payload
    },
    // Updating keeps the live token, so its expiry is not sent.
    update: (payload, snapshot) => {
      if (str(snapshot.enrollmentMode).startsWith("corporateOwnedAOSP")) {
        const body: Item = {}
        for (const key of AOSP_PATCHABLE) if (payload[key] !== undefined && payload[key] !== null) body[key] = payload[key] ?? null
        if (payload.deviceNameTemplate === null) body.deviceNameTemplate = ""
        return [patch(body)]
      }
      const body = { ...payload }
      for (const key of ["tokenExpirationDateTime", "accountId", "enrollmentTokenUsageCount"]) delete body[key]
      return [patch(body)]
    },
  },
  {
    folder: "DeviceCategories",
    label: "device categories",
    area: "Enrollment",
    path: "deviceManagement/deviceCategories",
    nameKey: "displayName",
    restore: "create",
  },
  {
    folder: "TermsAndConditions",
    label: "terms and conditions",
    area: "Enrollment",
    path: "deviceManagement/termsAndConditions",
    nameKey: "displayName",
    // termsAndConditions cannot expand assignments.
    extras: [{ property: "assignments", path: (id) => `deviceManagement/termsAndConditions/${id}/assignments` }],
    restore: "create",
    assign: "post",
    exclusionsUnsupported: true,
    readOnly: ["acceptanceStatuses", "groupAssignments"],
    // Graph requires a version of at least 1.
    prepare: (payload, snapshot) => {
      payload.version = typeof snapshot.version === "number" && snapshot.version >= 1 ? snapshot.version : 1
      return payload
    },
    // Replacing keeps the live version number, so users are not asked to accept the terms again.
    update: (payload) => {
      delete payload.version
      return [patch(payload)]
    },
  },

  // Tenant administration
  {
    folder: "AssignmentFilters",
    label: "assignment filters",
    area: "Tenant administration",
    path: "deviceManagement/assignmentFilters",
    nameKey: "displayName",
    restore: "create",
    readOnly: ["payloads"],
    // PATCH rejects `platform` ("Platform cannot be changed"), even unchanged.
    update: (payload) => {
      delete payload.platform
      return [patch(payload)]
    },
  },
  {
    folder: "ScopeTags",
    label: "scope tags",
    area: "Tenant administration",
    path: "deviceManagement/roleScopeTags",
    nameKey: "displayName",
    // $expand=assignments returns an empty list for scope tags.
    extras: [{ property: "assignments", path: (id) => `deviceManagement/roleScopeTags/${id}/assignments` }],
    skip: (item) => (item.isBuiltIn === true ? "Built-in scope tag" : undefined),
    restore: "create",
    assign: { key: "assignments" },
    readOnly: ["isBuiltIn"],
  },
  {
    folder: "RoleDefinitions",
    label: "Intune roles",
    area: "Tenant administration",
    path: "deviceManagement/roleDefinitions",
    nameKey: "displayName",
    // Expanded role assignments come back without members and scopes, so each is read on its own.
    extras: [
      {
        property: "roleAssignments",
        path: (id) => `deviceManagement/roleDefinitions/${id}/roleAssignments`,
        each: { path: (_id, assignmentId) => `deviceManagement/roleAssignments/${assignmentId}` },
      },
    ],
    skip: (item) => (item.isBuiltIn === true ? "Built-in role" : undefined),
    restore: "create",
    assignmentWarning: "Restoring this role with its assignments recreates the role memberships in the backup, including any revoked since. Review who gets this role in Intune.",
    readOnly: ["isBuiltIn", "isBuiltInRoleDefinition", "roleAssignments", "permissions"],
    after: (snapshot) =>
      collection(snapshot.roleAssignments).map((assignment) => {
        const body = cleanAssignment(assignment)
        body["roleDefinition@odata.bind"] = "https://graph.microsoft.com/beta/deviceManagement/roleDefinitions('{id}')"
        return { method: "POST", path: "deviceManagement/roleAssignments", body, kind: "assignments" } as Step
      }),
  },
  {
    folder: "NotificationTemplates",
    label: "compliance notification templates",
    area: "Tenant administration",
    path: "deviceManagement/notificationMessageTemplates",
    nameKey: "displayName",
    expand: "localizedNotificationMessages",
    restore: "create",
    readOnly: ["localizedNotificationMessages"],
    after: (snapshot) => localizedMessages(snapshot).map((body) => ({ method: "POST", path: "{collection}/{id}/localizedNotificationMessages", body, kind: "content" }) as Step),
    // Messages are matched by locale so replacing never adds a second message for the same language.
    update: (payload, snapshot, current) => {
      const live = new Map(collection(current.localizedNotificationMessages).map((message) => [str(message.locale), str(message.id)]))
      const wanted = localizedMessages(snapshot)
      const locales = new Set(wanted.map((message) => str(message.locale)))
      return [
        patch(payload),
        ...wanted.map((body): Step => {
          const existing = live.get(str(body.locale))
          return existing
            ? { method: "PATCH", path: `{collection}/{id}/localizedNotificationMessages/${existing}`, body, kind: "content" }
            : { method: "POST", path: "{collection}/{id}/localizedNotificationMessages", body, kind: "content" }
        }),
        ...[...live].filter(([locale]) => !locales.has(locale)).map(([, messageId]): Step => ({ method: "DELETE", path: `{collection}/{id}/localizedNotificationMessages/${messageId}`, body: {}, kind: "content" })),
      ]
    },
  },
  {
    folder: "Branding",
    label: "Company Portal branding",
    area: "Tenant administration",
    path: "deviceManagement/intuneBrandingProfiles",
    nameKey: "profileName",
    expand: "assignments",
    // Images are only returned when selected one at a time.
    extras: BRANDING_IMAGES.map((image) => ({ property: image, single: true, path: (id: string) => `deviceManagement/intuneBrandingProfiles/${id}?$select=${image}` })),
    restore: "create",
    restorable: (item) => (item.isDefaultProfile === true ? "This is the default branding. Restore updates it in place." : undefined),
    assign: { key: "assignments" },
    readOnly: ["isDefaultProfile"],
    // Graph refuses to create a profile with logos; they are set right after.
    prepare: (payload) => {
      for (const image of BRANDING_IMAGES) delete payload[image]
      return payload
    },
    after: (snapshot) => {
      const images: Item = {}
      for (const image of BRANDING_IMAGES) if (snapshot[image]) images[image] = snapshot[image] ?? null
      return Object.keys(images).length ? [{ method: "PATCH", path: "{collection}/{id}", body: images, kind: "content" }] : []
    },
    // disableClientTelemetry is accepted on create but not on PATCH. An image the backup recorded as empty is cleared.
    update: (payload, snapshot) => {
      delete payload.disableClientTelemetry
      const images: Item = {}
      for (const image of BRANDING_IMAGES) if (image in snapshot) images[image] = snapshot[image] ?? null
      return [patch(payload), ...(Object.keys(images).length ? [patch(images)] : [])]
    },
  },
  {
    folder: "DeviceCleanupRules",
    label: "device clean-up rules",
    area: "Tenant administration",
    path: "deviceManagement/managedDeviceCleanupRules",
    nameKey: "displayName",
    restore: "create",
  },
  {
    folder: "MultiAdminApprovalPolicies",
    label: "multi admin approval policies",
    area: "Tenant administration",
    path: "deviceManagement/operationApprovalPolicies",
    nameKey: "displayName",
    restore: "create",
  },
]

export const TYPE_BY_FOLDER = new Map(INTUNE_TYPES.map((type) => [type.folder.toLowerCase(), type]))

export function typeForFolder(folder: string): IntuneType | undefined {
  return TYPE_BY_FOLDER.get(folder.toLowerCase())
}

export function itemName(type: IntuneType, item: Item): string {
  return String(item[type.nameKey] ?? item.displayName ?? item.name ?? item.id ?? "unnamed")
}

/**
 * Restores objects other objects refer to first (scope tags, filters, categories, templates),
 * and policy sets last because they list other objects.
 */
const FIRST = ["ScopeTags", "AssignmentFilters", "RoleDefinitions", "AppCategories", "DeviceCategories", "NotificationTemplates", "ReusablePolicySettings"]
const LAST = ["PolicySets"]

export function restoreOrder(paths: string[]): string[] {
  const rank = (path: string) => {
    const folder = path.split("/")[1] ?? ""
    if (FIRST.includes(folder)) return FIRST.indexOf(folder)
    if (LAST.includes(folder)) return 1000
    const index = INTUNE_TYPES.findIndex((type) => type.folder.toLowerCase() === folder.toLowerCase())
    return 100 + (index < 0 ? 900 : index)
  }
  return [...paths].sort((a, b) => rank(a) - rank(b))
}
