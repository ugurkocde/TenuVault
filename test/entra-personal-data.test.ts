vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { ENTRA_5A_TYPES, ENTRA_5B_TYPES, ENTRA_5C_TYPES } from "../src/shared/intune/entra"
import { INTUNE_TYPES, type Item } from "../src/shared/intune/registry"
import { listSnapshot, readObject } from "../src/shared/intune/read"
import { sameSnapshot } from "../src/shared/intune/compare"
import { compareBackups } from "../src/shared/intune/backup-changes"
import { compareObjects } from "../src/portal/app/api/detect-drifts/route"
import { readEntraType } from "./helpers/entra-5a"
import { replay, type ReadFixture } from "./helpers/entra-5c"
import { fixture, scriptedGraph } from "./helpers/backup-fixture"

const ENTRA_TYPES = [...ENTRA_5A_TYPES, ...ENTRA_5B_TYPES, ...ENTRA_5C_TYPES]
const typeOf = (folder: string) => ENTRA_TYPES.find(type => type.folder === folder)!
const documented = (folder: string): ReadFixture => JSON.parse(readFileSync(new URL(`./fixtures/entra-5c/${folder}.documented.json`, import.meta.url), "utf8"))
const person = { id: "person-id", displayName: "Avery Morgan", userPrincipalName: "avery.morgan@example.test", mail: "avery.morgan@example.test" }
const namedSubjects: Item[] = [
  { "@odata.type": "#microsoft.graph.singleUser", userId: "user-b", description: "Avery Morgan" },
  { "@odata.type": "#microsoft.graph.singleUser", userId: "user-a", description: "Jordan Reed" },
  { "@odata.type": "#microsoft.graph.singleUser", id: "legacy-user", isBackup: true, description: "Sam Ellis" },
  { "@odata.type": "#microsoft.graph.groupMembers", groupId: "group-id", description: "Approvers" },
  { "@odata.type": "#microsoft.graph.connectedOrganizationMembers", connectedOrganizationId: "organization-id", description: "Partner" },
  { "@odata.type": "#microsoft.graph.singleServicePrincipal", servicePrincipalId: "application-id", description: "Application" },
  { "@odata.type": "#microsoft.graph.requestorManager", managerLevel: 2, isBackup: true },
  { "@odata.type": "#microsoft.graph.targetManager", managerLevel: 1 },
  { "@odata.type": "#microsoft.graph.internalSponsors" },
  { "@odata.type": "#microsoft.graph.externalSponsors" },
  { "@odata.type": "#microsoft.graph.targetUserSponsors" },
  { "@odata.type": "#microsoft.graph.targetApplicationOwners" },
  { "@odata.type": "#microsoft.graph.targetAgentIdentitySponsorsOrOwners" },
  { "@odata.type": "#microsoft.graph.attributeRuleMembers", membershipRule: "user.department -eq \"IT\"", description: "IT staff" },
  { "@odata.type": "#microsoft.graph.identityGovernance.ruleBasedSubjectSet", rule: "department eq 'IT'" },
  { "@odata.type": "#microsoft.graph.identityGovernance.groupBasedSubjectSet", groupId: "group-id" },
]
const normalizedSubjects = namedSubjects.map(({ description: _description, ...subject }) => subject)

// Check contextual name fields as well as profile keys. Configuration names and descriptions remain valid.
function scan(value: unknown, reference = false): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) { value.forEach(entry => scan(entry, reference)); return }
  const object = value as Item
  const subject = /singleUser|groupMembers|connectedOrganizationMembers|SubjectSet/i.test(String(object["@odata.type"]))
  for (const [key, child] of Object.entries(object)) {
    expect(key).not.toMatch(/^(userPrincipalName|mail|givenName|surname|principalName)$/i)
    if (reference || subject) expect(key).not.toMatch(/^(displayName|description|name|email)$/i)
    if (["createdBy", "modifiedBy", "lastModifiedBy", "addedBy"].includes(key)) expect(typeof child).not.toBe("string")
    scan(child, reference || subject || ["createdBy", "modifiedBy", "lastModifiedBy", "addedBy", "principal", "user", "assignedTo"].includes(key))
  }
}

describe("Entra stored personal data", () => {
  it("walks every stored fixture object across all 67 configuration types", async () => {
    expect(ENTRA_TYPES).toHaveLength(67)
    const visited = new Set<string>()
    for (const part of ["5a", "5b", "5c"]) {
      const root = new URL(`./fixtures/entra-${part}/`, import.meta.url)
      for (const file of readdirSync(root).filter(file => file.endsWith(".json") && !file.endsWith(".probe.json"))) {
        const data = JSON.parse(readFileSync(new URL(file, root), "utf8")) as ReadFixture
        const type = ENTRA_TYPES.find(type => type.folder === data.folder)
        if (!type || !data.responses) continue
        const result = await readEntraType(type, replay(data, type))
        result.objects.forEach(object => scan(object))
        visited.add(type.folder)
      }
    }
    expect([...visited].sort()).toEqual(ENTRA_TYPES.map(type => type.folder).sort())
  })

  it("stores named subjects only as selectors at every assignment policy location", async () => {
    const type = typeOf("AccessPackageAssignmentPolicies")
    const graph = replay(documented(type.folder), type)
    const get = graph.get
    graph.get = async path => ({ ...await get(path), description: "Policy purpose", specificAllowedTargets: namedSubjects,
      requestorSettings: { allowedRequestors: namedSubjects, onBehalfRequestors: namedSubjects },
      requestApprovalSettings: { stages: [{ primaryApprovers: namedSubjects, fallbackPrimaryApprovers: namedSubjects, escalationApprovers: namedSubjects, fallbackEscalationApprovers: namedSubjects }] },
      reviewSettings: { primaryReviewers: namedSubjects, fallbackReviewers: namedSubjects },
      nested: { futureSubject: namedSubjects[0]!, untyped: { primaryApprovers: [{ userId: "person-id", description: "Avery Morgan" }] } },
    })
    const object = await readObject(type, "example", graph)
    expect(object.description).toBe("Policy purpose")
    const check = (subjects: unknown) => expect(subjects).toEqual(expect.arrayContaining(normalizedSubjects))
    check(object.specificAllowedTargets)
    for (const subjects of Object.values(object.requestorSettings as Item)) check(subjects)
    for (const subjects of Object.values(((object.requestApprovalSettings as Item).stages as Item[])[0]!)) check(subjects)
    for (const subjects of Object.values(object.reviewSettings as Item)) check(subjects)
    expect((object.nested as Item).futureSubject).toEqual(normalizedSubjects[0])
    expect(((object.nested as Item).untyped as Item).primaryApprovers).toEqual([{ userId: "person-id" }])
    scan(object)
    expect(namedSubjects[0]!.description).toBe("Avery Morgan")
  })

  it("normalizes references on every Entra detail and list snapshot without changing the response", async () => {
    for (const type of ENTRA_TYPES) {
      const input: Item = { id: "example", tenantId: "example", resources: [], resourceRoleScopes: [], questions: [], customExtensionStageSettings: [], files: [], displayName: "Configuration", description: "Configuration purpose", principal: person, createdBy: person, lastModifiedBy: person, modifiedBy: "Avery Morgan", addedBy: "avery.morgan@example.test", nested: { subject: namedSubjects[0]!, person: { "@odata.type": "#microsoft.graph.user", ...person } } }
      const before = structuredClone(input)
      const object = await readObject(type, "example", { get: async () => type.singleton?.collection ? { value: [input] } : input, list: async () => [] })
      for (const stored of [object, listSnapshot(type, before)]) {
        scan(stored)
        expect(stored.principal).toEqual({ id: "person-id" })
        expect(stored.createdBy).toEqual({ id: "person-id" })
        expect(stored.lastModifiedBy).toEqual({ id: "person-id" })
        expect(stored).not.toHaveProperty("modifiedBy")
        expect(stored).not.toHaveProperty("addedBy")
        expect(stored.description).toBe("Configuration purpose")
      }
      expect(before.principal).toEqual(person)
      expect(input.principal).toEqual(person)
    }
  })

  it("keeps role approval selectors, review queries, authentication targets and configured notification emails", async () => {
    const cases: [string, Item][] = [
      ["RoleManagementPolicies", { rules: [{ id: "approval", setting: { approvalStages: [{ primaryApprovers: namedSubjects, escalationApprovers: namedSubjects }] } }, { id: "notification", notificationRecipients: ["avery.morgan@example.test"] }], effectiveRules: [{ id: "derived" }] }],
      ["AdminConsentRequestPolicy", { reviewers: [{ query: "/users/person-id", queryType: "MicrosoftGraph", displayName: "Avery Morgan" }] }],
      ["AccessReviewDefinitions", { reviewers: [{ query: "/users/person-id", queryType: "MicrosoftGraph", displayName: "Avery Morgan" }] }],
      ["AuthenticationMethodsPolicy", { authenticationMethodConfigurations: [{ id: "method", includeTargets: [{ id: "group-id", targetType: "group", isRegistrationRequired: false, authenticationMode: "push", displayName: "People" }] }] }],
      ["CrossTenantAccessPartners", { tenantId: "example", b2bCollaborationInbound: { usersAndGroups: { targets: [{ target: "person-id", targetType: "user", displayName: "Avery Morgan" }] } } }],
    ]
    for (const [folder, input] of cases) {
      const object = await readObject(typeOf(folder), "example", { get: async () => ({ id: "example", ...structuredClone(input) }), list: async () => [] })
      expect(JSON.stringify(object)).not.toContain("displayName")
      if (folder === "RoleManagementPolicies") {
        expect(object).not.toHaveProperty("effectiveRules")
        expect((object.rules as Item[]).find(rule => rule.id === "notification")!.notificationRecipients).toEqual(["avery.morgan@example.test"])
        expect((((object.rules as Item[])[0]!.setting as Item).approvalStages as Item[])[0]!.primaryApprovers).toEqual(normalizedSubjects)
      }
      if (folder === "AuthenticationMethodsPolicy") expect(((object.authenticationMethodConfigurations as Item[])[0]!.includeTargets as Item[])[0]).toEqual({ id: "group-id", targetType: "group", isRegistrationRequired: false, authenticationMode: "push" })
      if (folder.includes("Review") || folder === "AdminConsentRequestPolicy") expect(object.reviewers).toEqual([{ query: "/users/person-id", queryType: "MicrosoftGraph" }])
      if (folder === "CrossTenantAccessPartners") expect((((object.b2bCollaborationInbound as Item).usersAndGroups as Item).targets as Item[])[0]).toEqual({ target: "person-id", targetType: "user" })
    }
  })

  it("keeps actor GUIDs and identity-set IDs without ambiguous actor strings or expanded profiles", async () => {
    const id = "00000000-0000-4000-8000-000000000001"
    const input: Item = { id: "catalog", createdBy: id, modifiedBy: "Avery Morgan", lastModifiedBy: { user: person, application: { id: "app-id", displayName: "App" }, group: null, servicePrincipal: "Label" }, principal: [person, "Avery Morgan"] }
    const object = await readObject(typeOf("AccessPackageCatalogs"), "catalog", { get: async () => input, list: async () => [] })
    expect(object.createdBy).toEqual({ id })
    expect(object).not.toHaveProperty("modifiedBy")
    expect(object.lastModifiedBy).toEqual({ user: { id: "person-id" }, application: { id: "app-id" }, group: null })
    expect(object.principal).toEqual([{ id: "person-id" }])
    expect(input.principal).toEqual([person, "Avery Morgan"])
    scan(object)
  })

  it("keeps hardware OATH assignee IDs without names or last-use state", async () => {
    const object = await readObject(typeOf("HardwareOathDevices"), "device", { get: async () => ({ id: "device", serialNumber: "123456", assignedTo: person, lastUsedDateTime: "2026-11-01T00:00:00Z", status: "activated" }), list: async () => [] })
    expect(object.assignedTo).toEqual({ id: "person-id" })
    expect(object).not.toHaveProperty("lastUsedDateTime")
    expect(object).not.toHaveProperty("status")
    expect(object.serialNumber).toBe("123456")
    scan(object)
  })

  it("gives reordered on-behalf requestors identical stored fingerprints after normalization", async () => {
    const snapshots = []
    for (const reverse of [false, true]) {
      const data = documented("AccessPackageAssignmentPolicies")
      const body = Object.values(data.responses).find(answer => answer.body.id === "example")!.body
      body.requestorSettings = { onBehalfRequestors: structuredClone(reverse ? namedSubjects.toReversed() : namedSubjects) }
      if (reverse) for (const subject of (body.requestorSettings as Item).onBehalfRequestors as Item[]) subject.description = "Changed directory label"
      const routes = Object.fromEntries(Object.entries(data.responses).map(([path, answer]) => [decodeURIComponent(path), answer.body]))
      const setup = fixture(scriptedGraph(routes))
      const job = await setup.run({ scope: { excluded: INTUNE_TYPES.filter(type => type.folder !== data.folder).map(type => type.folder) } })
      expect(job.outcomes?.coverage).toBe("complete")
      snapshots.push((await setup.manifest(job)).Items)
    }
    expect(snapshots[0]).toEqual(snapshots[1])
    expect(compareBackups({ Status: "Success", Items: snapshots[0] }, { Status: "Success", Items: snapshots[1] })).toEqual([])
  })

  it("never stores advancing lifecycle execution state or reports it as drift", async () => {
    const snapshots = []
    const manifests = []
    for (const day of ["01", "02"]) {
      const type = typeOf("LifecycleWorkflows")
      const data = documented(type.folder)
      Object.assign(Object.values(data.responses).find(answer => answer.body.id === "example")!.body, { nextScheduleRunDateTime: `2026-11-${day}T00:00:00Z`, lastExecutionDateTime: `2026-11-${day}T00:00:00Z`, quarantineDetails: { quarantineStartTime: day }, executionScope: [person], previewScope: [person], subjectProcessingResults: [{ id: day }], taskReports: [{ id: day }] })
      const setup = fixture(scriptedGraph(Object.fromEntries(Object.entries(data.responses).map(([path, answer]) => [decodeURIComponent(path), answer.body]))))
      const job = await setup.run({ scope: { excluded: INTUNE_TYPES.filter(entry => entry.folder !== type.folder).map(entry => entry.folder) } })
      expect(job.outcomes?.coverage).toBe("complete")
      const files = (await setup.files(job)).filter(file => file.startsWith(type.folder + "/"))
      const object = (await setup.file(job, files[0]!))!
      for (const key of ["nextScheduleRunDateTime", "lastExecutionDateTime", "quarantineDetails", "executionScope", "previewScope", "subjectProcessingResults", "taskReports"]) expect(object).not.toHaveProperty(key)
      expect(object.isSchedulingEnabled).toBe(true)
      snapshots.push(object)
      manifests.push((await setup.manifest(job)).Items)
    }
    expect(sameSnapshot(snapshots[0]!, snapshots[1]!)).toBe(true)
    expect(compareObjects(snapshots[0]!, snapshots[1]!)).toEqual([])
    expect(manifests[0]).toEqual(manifests[1])
    expect(compareBackups({ Status: "Success", Items: manifests[0] }, { Status: "Success", Items: manifests[1] })).toEqual([])
  })

  it("excludes certificate refresh, PKI upload, onboarding and tenant transition runtime details", async () => {
    const domain = await readObject(typeOf("Domains"), "example", { get: async () => ({ id: "example" }), list: async path => path.includes("federationConfiguration") ? [{ id: "federation", signingCertificate: "public certificate", signingCertificateUpdateStatus: { lastRunDateTime: "2026-11-01T00:00:00Z", certificateUpdateResult: "success" } }] : [] })
    expect((domain.federationConfiguration as Item[])[0]).toEqual({ id: "federation", signingCertificate: "public certificate" })
    const pki = await readObject(typeOf("CertificateBasedAuthPki"), "example", { get: async () => ({ id: "example", status: "failed", statusDetails: "Upload failed" }), list: async () => [] })
    expect(pki).not.toHaveProperty("status")
    expect(pki).not.toHaveProperty("statusDetails")
    const catalog = await readObject(typeOf("AccessPackageCatalogs"), "example", { get: async () => ({ id: "example" }), list: async () => [{ id: "resource", isPendingOnboarding: true, roles: [], scopes: [] }] })
    expect((catalog.resources as Item[])[0]).not.toHaveProperty("isPendingOnboarding")
    const mto = await readObject(typeOf("MultiTenantOrganization"), "example", { get: async () => ({ id: "example" }), list: async () => [{ tenantId: "tenant", transitionDetails: { desiredRole: "member", desiredState: "active", status: "failed", details: "Retry pending" } }] })
    expect((mto.tenants as Item[])[0]!.transitionDetails).toEqual({ desiredRole: "member", desiredState: "active" })
  })

  it("excludes PIM and review runtime status and sync timestamps while keeping configured schedule dates", async () => {
    for (const folder of ["RoleEligibilitySchedules", "RoleAssignmentSchedules", "PimGroupEligibilitySchedules", "PimGroupAssignmentSchedules", "AccessReviewDefinitions", "Organization"]) {
      const type = typeOf(folder)
      const input = { id: "example", status: "Provisioned", onPremisesLastSyncDateTime: "2026-11-01T00:00:00Z", onPremisesLastPasswordSyncDateTime: "2026-11-01T00:00:00Z", onPremisesSyncStatus: [{ status: "Success" }], scheduleInfo: { startDateTime: "2026-11-01T00:00:00Z", expiration: { endDateTime: "2027-11-01T00:00:00Z" } } }
      const object = type.singleton ? await readObject(type, "example", { get: async () => ({ value: [input] }), list: async () => [] }) : listSnapshot(type, input)
      if (folder === "Organization") for (const key of ["onPremisesLastSyncDateTime", "onPremisesLastPasswordSyncDateTime", "onPremisesSyncStatus"]) expect(object).not.toHaveProperty(key)
      else expect(object).not.toHaveProperty("status")
      expect(object.scheduleInfo).toEqual(input.scheduleInfo)
    }
  })
})
