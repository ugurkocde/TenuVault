import { describe, expect, it } from "vitest"
import { convertKit, type KitFile } from "../src/shared/frameworks/cis-kit"
import { cisReadiness, headlineRate } from "../src/shared/frameworks/cis-readiness"
import type { CisException } from "../src/shared/frameworks/cis-exceptions"
import type { CisPortfolioHistoryEntry } from "../src/shared/frameworks/cis-portfolio"
import type { Finding } from "../src/shared/frameworks/policies"
import { cisScoreCards } from "../src/renderer/features/scores/cis"
import { freshData as freshCisWorkspace } from "../src/renderer/features/scores/api"
import { CIS_CARD_NOTE } from "../src/renderer/features/scores/CisCard"

const TENANT = "11111111-1111-1111-1111-111111111111"
const type = "#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance"
const policy = (name: string, description: string, settingId: string) => JSON.stringify({
  name, platforms: "windows10", technologies: "mdm", description,
  settings: [{ settingInstance: { "@odata.type": type, settingDefinitionId: settingId, choiceSettingValue: { value: "fake-on" } } }],
})

function entry(runId: string, assessedAt: string, statuses: Finding["status"][], benchmark = "fakebook-os", version = "9.9.9", tenantId = TENANT): CisPortfolioHistoryEntry {
  const files: KitFile[] = [
    { path: `Level 1/Fakebook Alpha ${version}.json`, content: policy("Fakebook Alpha", "Covers 7.1.1", "fakebook_setting_alpha") },
    { path: `Level 1/Fakebook Beta ${version}.json`, content: policy("Fakebook Beta", "Covers 7.1.2", "fakebook_setting_beta") },
    { path: `Level 2/Fakebook Gamma ${version}.json`, content: policy("Fakebook Gamma", "Covers 7.2.1", "fakebook_setting_gamma") },
  ]
  const pack = convertKit(files, { id: benchmark, version }).packs.flatMap((item) => item.policies)
  const findings: Finding[] = statuses.map((status, index) => ({
    key: `${index}:0`, policyIndex: index, settingIndex: 0, policyName: pack[index]!.name,
    settingId: String((pack[index]!.settings[0]!.settingInstance as { settingDefinitionId: string }).settingDefinitionId),
    status, recommended: null, observed: [],
  }))
  return { assessment: { runId, tenantId, frameworkId: "cis-benchmarks", reference: `${benchmark} ${version}`, assessedAt, policyCount: pack.length, findings }, policies: pack }
}

const exception: CisException = {
  id: "exc-1", benchmark: "fakebook-os", version: "9.9.9", level: 1, policyName: "Fakebook Beta", settingId: "fakebook_setting_beta",
  owner: "Owner", reason: "Accepted risk", expiresOn: "2099-01-01", createdAt: "2026-01-01T00:00:00.000Z",
}

describe("CIS card in Governance", () => {
  it("shows the raw headline rate cisReadiness gives the newest saved assessment, one card per benchmark", () => {
    const newest = entry("new", "2026-10-10T00:00:00.000Z", ["Present", "Missing", "Present"])
    const older = entry("old", "2026-09-01T00:00:00.000Z", ["Missing", "Missing", "Missing"])
    const other = entry("edge", "2026-10-01T00:00:00.000Z", ["Present", "Present", "Present"], "fakebrowser")
    const foreign = entry("foreign", "2026-10-12T00:00:00.000Z", ["Missing", "Missing", "Missing"], "fakebook-os", "9.9.9", "22222222-2222-2222-2222-222222222222")
    const workspace = { history: [older, other, newest, foreign] }
    const cards = cisScoreCards(true, workspace, TENANT)
    expect(cards.map((card) => [card.key, card.runId])).toEqual([["fakebook-os", "new"], ["fakebrowser", "edge"]])
    const expected = cisReadiness(newest.assessment, newest.policies).levels.map((level) => {
      const rate = headlineRate(level).rate
      return rate === null ? null : Math.round(rate * 1000) / 10
    })
    expect(cards[0]!.levels.map((level) => level.rate)).toEqual(expected)
    expect(cards[0]!.levels.map((level) => level.rate)).toEqual([50, 100])
    expect(cards[0]!.levels.every((level) => level.adjusted === null && level.exclusions === 0)).toBe(true)
  })

  it("adds the rate with exclusions next to the raw rate, applying exceptions like the CIS page", () => {
    const newest = entry("new", "2026-10-10T00:00:00.000Z", ["Present", "Missing", "Present"])
    const card = cisScoreCards(true, { history: [newest], exceptions: [exception] }, TENANT)[0]!
    const page = cisReadiness(newest.assessment, newest.policies, undefined, undefined, [exception])
    const level1 = card.levels.find((level) => level.level === 1)!
    expect(level1.rate).toBe(Math.round(headlineRate(page.levels[0]!).rate! * 1000) / 10)
    expect(level1).toMatchObject({ rate: 50, adjusted: 100, exclusions: 1 })
  })

  it("shows cards only from a successful read made after the tab opened, never cached data next to a failed refetch", () => {
    const workspace = { history: [entry("new", "2026-10-10T00:00:00.000Z", ["Present", "Missing", "Present"])] }
    const mountedAt = 1_000
    expect(freshCisWorkspace({ status: "success", data: workspace, dataUpdatedAt: 1_500 }, mountedAt)).toBe(workspace)
    // A failed refetch keeps the cached workspace in the query; it must not show as current.
    expect(freshCisWorkspace({ status: "error", data: workspace, dataUpdatedAt: 1_500 }, mountedAt)).toBeUndefined()
    // Cached from an earlier visit, before the fresh read is in.
    expect(freshCisWorkspace({ status: "success", data: workspace, dataUpdatedAt: 500 }, mountedAt)).toBeUndefined()
    expect(freshCisWorkspace({ status: "pending", data: undefined, dataUpdatedAt: 0 }, mountedAt)).toBeUndefined()
    expect(cisScoreCards(true, freshCisWorkspace({ status: "error", data: workspace, dataUpdatedAt: 1_500 }, mountedAt), TENANT)).toEqual([])
  })

  it("shows nothing CIS when CIS access is off", () => {
    const workspace = { history: [entry("new", "2026-10-10T00:00:00.000Z", ["Present", "Missing", "Present"])] }
    expect(cisScoreCards(false, workspace, TENANT)).toEqual([])
    expect(cisScoreCards(true, null, TENANT)).toEqual([])
  })

  it("says CIS checks configuration so it does not contradict the assigned-only framework scores", () => {
    expect(CIS_CARD_NOTE).toMatch(/CIS checks configuration/)
    expect(CIS_CARD_NOTE).toMatch(/unassigned policies count as present/)
  })
})
