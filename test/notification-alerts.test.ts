import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { changeEvent, mapAuditEvent, type AuditChange, type AuditEventRaw } from "../src/shared/notifications/audit"
import { mapEntraAuditEvent, type EntraAuditRaw } from "../src/shared/notifications/entra"
import { canonicalJson, type NotificationSeverity } from "../src/shared/notifications/envelope"
import { emailHtml, emailText, teamsWorkflowsPayload } from "../src/shared/notifications/render"
import { DEFAULT_CARD_STYLE } from "../src/shared/notifications/layout"
import { entraChangedSettings, intuneChangedSettings } from "../src/shared/notifications/settings"
import { changeMatches, describeConditions, MAX_EACH_PER_CHECK, parseConditions, planChangeAlerts, WATCHER_ALERTS_SCHEMA, watcherAlertsHash, type AlertMatcher, type WatcherAlert, type WatcherAlerts } from "../src/shared/notifications/alerts"
import live from "./fixtures/notifications/alert-live.json"

const pwsh = ["/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh", "/usr/bin/pwsh", ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/pwsh`] : [])].find((candidate) => existsSync(candidate))

const intune = live.intune.map((event) => mapAuditEvent(event as AuditEventRaw)).filter((change): change is AuditChange => change !== null)
const entra = live.entra.map((event) => mapEntraAuditEvent(event as EntraAuditRaw)).filter((change): change is AuditChange => change !== null)
const context = { tenantId: live.tenantId, tenantName: live.tenantName, includeActor: true, source: "azure-watcher" as const }

/** The watcher alerts in the fixture as the matcher reads them. */
const matchers: Array<AlertMatcher & { destinations: string[] }> = (live.alerts as unknown as WatcherAlert[]).map((alert) => ({ ...alert, enabled: true, conditions: parseConditions(alert.conditions) }))

describe("changed setting names", () => {
  it("names the settings an Intune update changed, never their values", () => {
    const update = intune.find((change) => change.auditId === "live-intune-update")!
    expect(update.settings).toEqual(["PasswordRequired", "BitLockerEnabled", "OsMinimumVersion"])
    expect(update.resourceId).toBe("44444444-0000-0000-0000-000000000004")
    expect(JSON.stringify(update)).not.toContain("10.0.22631")
  })

  it("names nothing for creates, and nothing for settings catalog updates that record no old values", () => {
    expect(intune.find((change) => change.auditId === "live-intune-create")!.settings).toEqual([])
    const catalog = intune.find((change) => change.auditId === "live-catalog-patch")!
    expect(catalog.changeType).toBe("updated")
    expect(catalog.settings).toEqual([])
  })

  it("names the paths a Conditional Access update changed, leaving out bookkeeping fields", () => {
    const update = entra.find((change) => change.auditId === "IPCGraph_live-ca-update")!
    expect(update.settings).toEqual(["conditions.clientAppTypes", "state"])
    expect(JSON.stringify(update)).not.toContain("enabledForReportingButNotEnforced")
    expect(JSON.stringify(update)).not.toContain("mobileAppsAndDesktopClients")
  })

  it("treats a recorded empty value alike however Intune writes it, and folds collection indexes", () => {
    const resource = { modifiedProperties: [
      { displayName: "PasswordMinimumLength", oldValue: "null", newValue: "<null>" },
      { displayName: "$Collection.RoleScopeTagIds[0]", oldValue: "Default", newValue: "Tier1" },
      { displayName: "$Collection.RoleScopeTagIds[1]", oldValue: "<null>", newValue: "Tier2" },
      { displayName: "LastModifiedDateTime", oldValue: "a", newValue: "b" },
      { displayName: "Secret", oldValue: null, newValue: "x" },
    ] }
    expect(intuneChangedSettings(resource)).toEqual({ names: ["RoleScopeTagIds"], more: 0 })
  })

  it("keeps every changed name for matching, and shows 15 with a count of the rest", () => {
    const resource = { modifiedProperties: Array.from({ length: 22 }, (_, index) => ({ displayName: `Setting${index}`, oldValue: "a", newValue: "b" })) }
    const result = intuneChangedSettings(resource)
    expect(result).toEqual({ names: resource.modifiedProperties.map((entry) => entry.displayName), more: 0 })
    const change: AuditChange = { ...intune[1]!, settings: result.names, settingsMore: 0 }
    expect(changeMatches(parseConditions({ settingNames: ["Setting21"] }), change, "intune")).toBe(true)
    const envelope = changeEvent("intune", { ...context, change })
    expect(envelope.items[0]!.change).toMatchObject({ settingsMore: 7 })
    expect(envelope.items[0]!.change!.settings).toHaveLength(15)
    expect(envelope.summary).toContain("Setting14 and 7 more.")
  })

  it("keeps two policies that share a name as two lines", () => {
    const twin: AuditChange = { ...intune[1]!, auditId: "twin", resourceId: "77777777-0000-0000-0000-000000000007", settings: ["TpmRequired"] }
    const digest = changeEvent("intune", { ...context, change: intune[1]! })
    expect(digest.items).toHaveLength(1)
    const plan = planChangeAlerts("intune", [intune[1]!, twin], [{ id: "a", enabled: true, eventTypes: ["intune.change"], minSeverity: "info" }], context)
    expect(plan[0]!.envelope.items.map((item) => item.change?.resourceId)).toEqual(["44444444-0000-0000-0000-000000000004", "77777777-0000-0000-0000-000000000007"])
  })

  it("names an object that only changed between null and empty", () => {
    const result = entraChangedSettings([{ modifiedProperties: [{ displayName: "ConditionalAccessPolicy", oldValue: JSON.stringify({ sessionControls: null }), newValue: JSON.stringify({ sessionControls: {} }) }] }])
    expect(result.names).toEqual(["sessionControls"])
  })

  it("compares lists whole and stops at three levels", () => {
    const before = JSON.stringify({ conditions: { users: { excludeGroups: ["a"], nested: { deep: 1 } } }, grantControls: { builtInControls: ["mfa"] } })
    const after = JSON.stringify({ conditions: { users: { excludeGroups: ["a", "b"], nested: { deep: 2 } } }, grantControls: { builtInControls: ["mfa"] } })
    expect(entraChangedSettings([{ modifiedProperties: [{ displayName: "ConditionalAccessPolicy", oldValue: before, newValue: after }] }]).names).toEqual(["conditions.users.excludeGroups", "conditions.users.nested"])
  })
})

describe("alert conditions", () => {
  const update = intune.find((change) => change.auditId === "live-intune-update")!
  const caUpdate = entra.find((change) => change.auditId === "IPCGraph_live-ca-update")!

  it("narrow by change type, category, policy name, changed setting and actor", () => {
    expect(changeMatches(parseConditions({ changeTypes: ["deleted"] }), update, "intune")).toBe(false)
    expect(changeMatches(parseConditions({ categories: ["COMPLIANCE"] }), update, "intune")).toBe(true)
    expect(changeMatches(parseConditions({ categories: ["DeviceConfiguration"] }), update, "intune")).toBe(false)
    expect(changeMatches(parseConditions({ policyNames: ["alerts-test"] }), update, "intune")).toBe(true)
    expect(changeMatches(parseConditions({ policyNames: ["Baseline"] }), update, "intune")).toBe(false)
    expect(changeMatches(parseConditions({ settingNames: ["bitlocker"] }), update, "intune")).toBe(true)
    expect(changeMatches(parseConditions({ settingNames: ["firewall"] }), update, "intune")).toBe(false)
    expect(changeMatches(parseConditions({ excludeActors: ["lab automation"] }), update, "intune")).toBe(false)
  })

  it("matches whole policy names with exact matching, ignoring case and surrounding spaces", () => {
    const exact = (...names: string[]) => parseConditions({ policyNames: names, policyNameMatch: "exact" })
    expect(changeMatches(exact("tv-alerts-test compliance"), update, "intune")).toBe(true)
    // A part of the name is enough for contains, never for exact.
    expect(changeMatches(exact("alerts-test"), update, "intune")).toBe(false)
    expect(changeMatches(parseConditions({ policyNames: ["alerts-test"], policyNameMatch: "contains" }), update, "intune")).toBe(true)
    expect(changeMatches(exact("TV-ALERTS-TEST compliance"), { ...update, resourceName: "\u00a0TV-ALERTS-TEST Compliance\t " }, "intune")).toBe(true)
    expect(changeMatches(exact("TV-ALERTS-TEST compliance"), { ...update, resourceName: "TV-ALERTS-TEST compliance (copy)" }, "intune")).toBe(false)
    expect(changeMatches(exact("TV-ALERTS-TEST compliance"), { ...update, resourceName: null }, "intune")).toBe(false)
    expect(changeMatches(exact("Other", "TV-ALERTS-TEST CA"), caUpdate, "conditionalAccess")).toBe(true)
  })

  it("keeps exact matching only with names, so older alerts and their watcher hash stay the same", () => {
    expect(parseConditions({ policyNames: ["A"] })).not.toHaveProperty("policyNameMatch")
    expect(parseConditions({ policyNames: ["A"], policyNameMatch: "contains" })).not.toHaveProperty("policyNameMatch")
    expect(parseConditions({ policyNames: ["A"], policyNameMatch: "EXACT" })).not.toHaveProperty("policyNameMatch")
    expect(parseConditions({ policyNames: [], policyNameMatch: "exact" })).toBeNull()
    expect(parseConditions({ policyNames: [], settingNames: ["x"], policyNameMatch: "exact" })).not.toHaveProperty("policyNameMatch")
    expect(describeConditions(parseConditions({ policyNames: ["A", "B"], policyNameMatch: "exact" }))).toBe('policies named "A" or "B"')
  })

  it("leaves Conditional Access changes alone when an alert picks Intune categories", () => {
    expect(changeMatches(parseConditions({ categories: ["Compliance"] }), caUpdate, "conditionalAccess")).toBe(true)
  })

  it("reads stored conditions leniently and describes them", () => {
    const parsed = parseConditions({ changeTypes: ["updated", "bogus"], policyNames: ["  A  ", "a", 7, ""], settingNames: "not a list", extra: true })
    expect(parsed).toEqual({ changeTypes: ["updated"], categories: [], policyNames: ["A"], settingNames: [], excludeActors: [] })
    expect(parseConditions({ changeTypes: [] })).toBeNull()
    expect(describeConditions(parsed)).toBe('updated only; policy names containing "A"')
  })
})

describe("planning alerts for one poll", () => {
  it("gives an alert without conditions the same digest as before alerts had conditions", () => {
    const plan = planChangeAlerts("intune", intune, [{ id: "plain", enabled: true, eventTypes: ["intune.change"], minSeverity: "info" }], context)
    expect(plan).toHaveLength(1)
    expect(plan[0]!.envelope.items).toHaveLength(3)
    expect(plan[0]!.alertIds).toEqual(["plain"])
  })

  it("sends one alert per change with the changed settings, keyed by the audit id", () => {
    const plan = planChangeAlerts("intune", intune, matchers, context)
    const single = plan.find((entry) => entry.alertIds.includes("compliance-each"))!
    expect(single.envelope.title).toBe("Intune change: TV-ALERTS-TEST compliance updated")
    expect(single.envelope.summary).toContain("Changed settings: PasswordRequired, BitLockerEnabled, OsMinimumVersion.")
    expect(single.envelope.items[0]!.change).toMatchObject({ auditId: "live-intune-update", changeType: "updated", resourceId: "44444444-0000-0000-0000-000000000004", settings: ["PasswordRequired", "BitLockerEnabled", "OsMinimumVersion"] })
    expect(plan.filter((entry) => entry.alertIds.includes("compliance-each"))).toHaveLength(1)
    // Excluded actor: nothing; warning floor: no deletes here, nothing.
    expect(plan.some((entry) => entry.alertIds.includes("no-lab"))).toBe(false)
    expect(plan.some((entry) => entry.alertIds.includes("warnings"))).toBe(false)
  })

  it("lets two alerts that pick the same changes share one envelope", () => {
    const plan = planChangeAlerts("intune", intune, [
      { id: "a", enabled: true, eventTypes: ["intune.change"], minSeverity: "info" },
      { id: "b", enabled: true, eventTypes: ["intune.change"], minSeverity: "info", conditions: parseConditions({ policyNames: [""] }) },
      { id: "off", enabled: false, eventTypes: ["intune.change"], minSeverity: "info" },
    ], context)
    expect(plan).toHaveLength(1)
    expect(plan[0]!.alertIds).toEqual(["a", "b"])
  })

  it("sends the changes past the per-check limit in one summary", () => {
    const many: AuditChange[] = Array.from({ length: MAX_EACH_PER_CHECK + 3 }, (_, index) => ({ ...intune[1]!, auditId: `bulk-${index}`, resourceId: `bulk-id-${index}`, resourceName: `Policy ${index}`, at: `2026-11-06T10:${String(index).padStart(2, "0")}:00.000Z` }))
    const plan = planChangeAlerts("intune", many, [{ id: "each", enabled: true, eventTypes: ["intune.change"], minSeverity: "info", delivery: "each" }], context)
    expect(plan).toHaveLength(MAX_EACH_PER_CHECK + 1)
    expect(plan.at(-1)!.envelope.title).toBe("Intune changes: Contoso")
    expect(plan.at(-1)!.envelope.items).toHaveLength(3)
  })

  it("applies the minimum severity to the envelope an alert would send", () => {
    const deleted: AuditChange = { ...intune[1]!, auditId: "gone", changeType: "deleted", settings: [] }
    const alerts: AlertMatcher[] = [{ id: "warn", enabled: true, eventTypes: ["intune.change"], minSeverity: "warning" as NotificationSeverity, delivery: "each" }]
    const plan = planChangeAlerts("intune", [intune[1]!, deleted], alerts, context)
    expect(plan.map((entry) => entry.envelope.items[0]!.change?.auditId)).toEqual(["gone"])
  })
})

describe("rendering changed settings", () => {
  const envelope = changeEvent("intune", { ...context, change: intune.find((change) => change.auditId === "live-intune-update")! })

  it("shows the names in mail, Teams and plain text, escaped, and never a value", () => {
    expect(emailHtml(envelope)).toContain("Changed: PasswordRequired, BitLockerEnabled, OsMinimumVersion")
    expect(emailText(envelope)).toContain("Changed: PasswordRequired, BitLockerEnabled, OsMinimumVersion")
    const card = JSON.stringify(teamsWorkflowsPayload(envelope, DEFAULT_CARD_STYLE))
    expect(card).toContain("Changed: PasswordRequired, BitLockerEnabled, OsMinimumVersion")
    for (const text of [emailHtml(envelope), card, canonicalJson(envelope)]) {
      expect(text).not.toContain("10.0.22631")
      expect(text).not.toContain("10.0.19045")
    }
  })

  it("escapes a hostile setting name in every format", () => {
    const hostile = changeEvent("intune", { ...context, change: { ...intune[1]!, settings: ["<img src=x>[link](https://evil.example)"] } })
    expect(emailHtml(hostile)).not.toContain("<img")
    expect(JSON.stringify(teamsWorkflowsPayload(hostile))).toContain("\\\\[link\\\\]\\\\(https://evil\\\\.example\\\\)")
  })
})

describe("watcher parity", () => {
  it.runIf(Boolean(pwsh))("PowerShell maps, plans and renders alerts exactly like TypeScript", () => {
    const script = fileURLToPath(new URL("./fixtures/notifications/render-alerts.ps1", import.meta.url))
    const [mappedIntune, mappedEntra, intunePlan, entraPlan, teams, mail, routing, taking] = execFileSync(pwsh!, ["-NoProfile", "-File", script], { encoding: "utf8" }).trim().split(/\r?\n/)
    expect(mappedIntune).toBe(canonicalJson(intune))
    expect(mappedEntra).toBe(canonicalJson(entra))
    const planJson = (service: "intune" | "conditionalAccess", changes: AuditChange[]) => canonicalJson(planChangeAlerts(service, changes, matchers, context).map((entry) => ({
      alertIds: entry.alertIds,
      destinations: ["webhook", "teams", "mail"].filter((destination) => matchers.some((alert) => entry.alertIds.includes(alert.id) && alert.destinations.includes(destination))),
      envelope: entry.envelope,
    })))
    expect(intunePlan).toBe(planJson("intune", intune))
    expect(entraPlan).toBe(planJson("conditionalAccess", entra))
    const single = planChangeAlerts("intune", intune, matchers, context).find((entry) => entry.alertIds.includes("compliance-each"))!.envelope
    expect(teams).toBe(canonicalJson(teamsWorkflowsPayload(single, DEFAULT_CARD_STYLE)))
    expect(JSON.parse(mail!)).toBe(emailHtml(single))
    expect(JSON.parse(taking!)).toEqual(["all"])
    // Exact names: the full names pick their policies, a part of a name picks nothing.
    const planned = [...planChangeAlerts("intune", intune, matchers, context), ...planChangeAlerts("conditionalAccess", entra, matchers, context)]
    expect(planned.filter((entry) => entry.alertIds.includes("exact-hit")).map((entry) => entry.envelope.items[0]!.change!.auditId).sort()).toEqual(["IPCGraph_live-ca-create", "IPCGraph_live-ca-update", "live-intune-create", "live-intune-update"])
    expect(planned.filter((entry) => entry.alertIds.includes("exact-miss"))).toEqual([])
    // Without alerts everything goes everywhere; with alerts only to set up destinations of alerts that take it.
    expect(JSON.parse(routing!)).toEqual({ legacy: ["webhook", "teams", "mail"], routed: ["teams"], planned: ["webhook"], nobody: [] })
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell matches policy names exactly like TypeScript", () => {
    const update = intune.find((change) => change.auditId === "live-intune-update")!
    const names = ["TV-ALERTS-TEST compliance", " tv-alerts-test COMPLIANCE ", "\u00a0TV-ALERTS-TEST compliance\t", "TV-ALERTS-TEST compliance ", "TV-ALERTS-TEST", "compliance", "TV-ALERTS-TEST  compliance", "Straße policy", "STRASSE POLICY", "", "\u00e9t\u00e9 \u00c9T\u00c9"]
    const conditions = [["TV-ALERTS-TEST compliance"], ["tv-alerts-test"], ["Straße policy"], ["été ÉTÉ"], ["x", " TV-ALERTS-TEST compliance"]]
    const cases = names.flatMap((name) => conditions.flatMap((policyNames) => ["exact", "contains"].map((policyNameMatch) => ({ change: { ...update, resourceName: name || null }, conditions: { policyNames, policyNameMatch } }))))
    const expected = cases.map((entry) => changeMatches(parseConditions(entry.conditions), entry.change, "intune"))
    const runbook = fileURLToPath(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url))
    const command = `. '${runbook}' -LibraryOnly; $cases = [Console]::In.ReadToEnd() | ConvertFrom-Json; $out = foreach ($case in $cases) { [bool](Test-TvChangeMatches (ConvertTo-TvAlertConditions $case.conditions) $case.change "intune") }; ConvertTo-Json -Compress @($out)`
    const actual = JSON.parse(execFileSync(pwsh!, ["-NoProfile", "-Command", command], { input: JSON.stringify(cases), encoding: "utf8" }).trim())
    expect(actual).toEqual(expected)
    expect(expected.filter(Boolean).length).toBeGreaterThan(10)
  }, 60_000)

  it.runIf(Boolean(pwsh))("PowerShell hashes the saved alerts file exactly like TypeScript hashes the alerts", () => {
    const document: WatcherAlerts = { schema: WATCHER_ALERTS_SCHEMA, alerts: (live.alerts as unknown as WatcherAlert[]).map((alert) => ({ ...alert, conditions: parseConditions(alert.conditions) })) }
    const script = (text: string) => `. '${fileURLToPath(new URL("../resources/runbooks/Invoke-TenuVaultNotificationCheck.ps1", import.meta.url))}' -LibraryOnly; Get-TvWatcherAlertsHash ([Console]::In.ReadToEnd())${text}`
    const hash = (input: string) => execFileSync(pwsh!, ["-NoProfile", "-Command", script("")], { input, encoding: "utf8" }).trim()
    // The file the user saves is the pretty JSON the app copies; the hash ignores its layout.
    expect(hash(JSON.stringify(document, null, 2))).toBe(watcherAlertsHash(document))
    expect(hash(JSON.stringify(document))).toBe(watcherAlertsHash(document))
    expect(hash(JSON.stringify({ schema: WATCHER_ALERTS_SCHEMA, alerts: [] }))).toBe("none")
    expect(hash("not json")).toBe("unreadable")
    // Characters a culture aware comparison treats as ignorable keep their own encoding.
    const ignorable: WatcherAlerts = { ...document, alerts: [{ ...document.alerts[0]!, title: "Soft\u00adhyphen \u200d joiner \ufeff bom \u200b space \u007f del" }] }
    expect(hash(JSON.stringify(ignorable, null, 2))).toBe(watcherAlertsHash(ignorable))
    expect(watcherAlertsHash(null)).toBe("none")
  }, 60_000)
})
