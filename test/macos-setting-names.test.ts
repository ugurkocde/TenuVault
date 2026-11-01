import { beforeEach, describe, expect, it } from "vitest"
import type { GraphCall } from "../src/portal/lib/policies/graph-restore"
import type { Item } from "../src/shared/intune/registry"
import type { SettingNames } from "../src/shared/intune/drift"
import type { RecommendationResult } from "../src/shared/frameworks/cis-recommendations"
import { clearSettingNames, readSettingNames } from "../src/portal/lib/drift/setting-names"
import { definitionLabel, GENERIC_GROUP_NAME as SHARED_GENERIC_NAME, payloadSettingId, settingLabel } from "../src/shared/intune/drift-format"
import { humanSettingLabel, knownSettingName, readableDiffEntry, settingDisplayName } from "../src/shared/frameworks/cis-display"
import { searchRecommendationResults } from "../src/shared/frameworks/recommendation-filter"
import { summarizeSetting } from "../src/shared/frameworks/setting-summary"

const GENERIC_GROUP_NAME = "Top Level Setting Group Collection"

// Shapes as Graph beta deviceManagement/configurationSettings/{id} returns them for macOS payloads;
// Restrictions has the keyword "Restrictions" in Graph and is left without one here to cover that case.
const GATEKEEPER = "com.apple.systempolicy.control_com.apple.systempolicy.control"
const RESTRICTIONS = "com.apple.applicationaccess_com.apple.applicationaccess"
const ASSESSMENT = "com.apple.systempolicy.control_enableassessment"
const FILEVAULT = "com.apple.mcx.filevault2_com.apple.mcx.filevault2"
const definitions: Record<string, Record<string, unknown>> = {
  [GATEKEEPER]: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSettingGroupCollectionDefinition", displayName: GENERIC_GROUP_NAME, name: "com.apple.systempolicy.control", description: "com.apple.systempolicy.control", keywords: [" System Policy Control ", "Gatekeeper Settings", "GateKeeper"], childIds: [ASSESSMENT] },
  [RESTRICTIONS]: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSettingGroupCollectionDefinition", displayName: GENERIC_GROUP_NAME, description: "Synthetic Top Level Setting Group Collection", keywords: [] },
  [FILEVAULT]: { "@odata.type": "#microsoft.graph.deviceManagementConfigurationSettingGroupCollectionDefinition", displayName: GENERIC_GROUP_NAME, keywords: [" ", 7, "FileVault"] },
  [ASSESSMENT]: { displayName: "Enable Assessment", options: [{ itemId: `${ASSESSMENT}_false`, displayName: "False" }, { itemId: `${ASSESSMENT}_true`, displayName: "True" }] },
}

function batchGraph() {
  const requested: string[] = []
  const graph: GraphCall = async (_method, _path, body) => {
    const requests = (body?.requests ?? []) as Array<{ id: string; url: string }>
    return {
      status: 200,
      body: {
        responses: requests.map((request) => {
          const id = decodeURIComponent(request.url.split("/").pop() ?? "")
          requested.push(id)
          return definitions[id] ? { id: request.id, status: 200, body: definitions[id] } : { id: request.id, status: 404, body: {} }
        }),
      } as unknown as Item,
    }
  }
  return { graph, requested }
}

/** A Gatekeeper payload as a CIS pack and a tenant policy hold it: a group collection with a choice child. */
const gatekeeper = (value: "true" | "false") => ({
  "@odata.type": "#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance",
  settingDefinitionId: GATEKEEPER,
  groupSettingCollectionValue: [{ children: [{ "@odata.type": "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance", settingDefinitionId: ASSESSMENT, choiceSettingValue: { value: `${ASSESSMENT}_${value}`, children: [] } }] }],
})

/** Names cached before this fix, or stored with a saved scan, still hold the generic name. */
const staleNames: SettingNames = { settings: { [GATEKEEPER]: GENERIC_GROUP_NAME, [RESTRICTIONS]: GENERIC_GROUP_NAME, [ASSESSMENT]: "Enable Assessment" }, options: { [`${ASSESSMENT}_true`]: "True", [`${ASSESSMENT}_false`]: "False" } }

describe("macOS setting group names from Graph", () => {
  beforeEach(() => clearSettingNames())

  it("skips blank and non-text keywords", async () => {
    const { graph } = batchGraph()
    const names = await readSettingNames([FILEVAULT], graph)
    expect(names.settings[FILEVAULT]).toBe("FileVault")
  })

  it("names a group collection by its first keyword, leaves it unnamed without one and keeps normal names", async () => {
    const { graph } = batchGraph()
    const names = await readSettingNames([GATEKEEPER, RESTRICTIONS, ASSESSMENT], graph)
    expect(names.settings[GATEKEEPER]).toBe("System Policy Control")
    expect(Object.hasOwn(names.settings, RESTRICTIONS)).toBe(false)
    expect(names.settings[ASSESSMENT]).toBe("Enable Assessment")
    expect(names.options).toEqual({ [`${ASSESSMENT}_false`]: "False", [`${ASSESSMENT}_true`]: "True" })
    expect(Object.values(names.settings)).not.toContain(GENERIC_GROUP_NAME)
  })

  it("does not ask Graph again for a definition read before, named or not", async () => {
    await readSettingNames([GATEKEEPER, RESTRICTIONS, ASSESSMENT], batchGraph().graph)
    const again = batchGraph()
    const names = await readSettingNames([GATEKEEPER, RESTRICTIONS, ASSESSMENT], again.graph)
    expect(again.requested).toEqual([])
    expect(names.settings[GATEKEEPER]).toBe("System Policy Control")
    expect(Object.hasOwn(names.settings, RESTRICTIONS)).toBe(false)
  })
})

describe("macOS setting group names in the views", () => {
  it("shares one constant for the generic name", () => {
    expect(SHARED_GENERIC_NAME).toBe(GENERIC_GROUP_NAME)
  })

  it("reads a doubled payload id as the payload id once", () => {
    expect(payloadSettingId(GATEKEEPER)).toBe("com.apple.systempolicy.control")
    expect(payloadSettingId(ASSESSMENT)).toBe(ASSESSMENT)
    expect(payloadSettingId("a_b")).toBe("a_b")
    expect(humanSettingLabel(RESTRICTIONS)).toBe("Com.apple.applicationaccess")
    expect(definitionLabel(RESTRICTIONS)).toBe("Application access")
  })

  it("labels a nested macOS finding by its keyword name, or its payload id when only the generic name is known", () => {
    const fresh: SettingNames = { settings: { ...staleNames.settings, [GATEKEEPER]: "System Policy Control" }, options: staleNames.options }
    expect(settingDisplayName(GATEKEEPER, fresh)).toBe("System Policy Control")
    expect(settingDisplayName(GATEKEEPER, staleNames)).toBe("Com.apple.systempolicy.control")
    expect(knownSettingName(GATEKEEPER, staleNames)).toBeNull()
    expect(knownSettingName(GATEKEEPER, fresh)).toBe("System Policy Control")
    // The setting summary still lists the child under the group.
    expect(summarizeSetting(gatekeeper("true"), fresh)).toEqual(["System Policy Control: Enable Assessment: Selected option: True"])
    const stale = summarizeSetting(gatekeeper("true"), staleNames)
    expect(stale.join("\n")).not.toContain(GENERIC_GROUP_NAME)
    expect(stale).toEqual(["com.apple.systempolicy.control: Enable Assessment: Selected option: True"])
  })

  it("keeps the generic name out of the recommendation search text", () => {
    const items: RecommendationResult[] = [{ id: "2.3.1", title: "Synthetic gate check is enabled", level: 1, result: "Fail", settings: [{ id: GATEKEEPER, status: "Different", findingKeys: [] }], findingKeys: [] }]
    expect(searchRecommendationResults(items, "top level setting group", staleNames)).toHaveLength(0)
    expect(searchRecommendationResults(items, "systempolicy", staleNames)).toHaveLength(1)
  })

  it("names a deployment difference after the group without the generic name", () => {
    const entry = { path: `settings.${GATEKEEPER}`, definitionId: GATEKEEPER, before: JSON.stringify({ settingInstance: gatekeeper("false") }), after: JSON.stringify({ settingInstance: gatekeeper("true") }) }
    const readable = readableDiffEntry(entry, staleNames)
    expect(readable.label).toBe("System policy: Control")
    expect(JSON.stringify(readable)).not.toContain(GENERIC_GROUP_NAME)
    expect(readable.after).toContain("Enable Assessment: Selected option: True")
    expect(readableDiffEntry({ path: "(object)", afterSettings: [{ definitionId: GATEKEEPER, value: "x" }] }, staleNames).afterValues?.shown).toEqual(["System policy: Control: x"])
  })

  it("labels a drift change on the group without the generic name", () => {
    expect(settingLabel({ field: `settings[${GATEKEEPER}]` }, staleNames).label).toBe("System policy: Control")
    expect(definitionLabel(GATEKEEPER, { settings: { [GATEKEEPER]: "System Policy Control" }, options: {} })).toBe("System Policy Control")
    // A child keeps its own name.
    expect(settingLabel({ field: `settings[${GATEKEEPER}].settingInstance.groupSettingCollectionValue[0].children[${ASSESSMENT}].choiceSettingValue.value` }, staleNames).label).toBe("Enable Assessment")
  })
})
