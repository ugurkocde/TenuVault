import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { frameworks, NCSC_COMMIT } from "../src/shared/frameworks/catalog"
import { comparePolicies, type Json } from "../src/shared/frameworks/policies"
import { decodePackFile, loadNcsc, NCSC_NOT_ASSESSED, NCSC_SETTINGS_CATALOG, parseNcscFile } from "../src/main/frameworks/ncsc"
import { handleFramework } from "../src/main/frameworks/service"
import { planGuard, requiredFeature } from "../src/main/api/plan-gates"
import { allows } from "../src/shared/plans"
import { workspaceExportCSV, workspaceExportJSON, workspaceReportHeader } from "../src/shared/compliance/export"

const TENANT = "11111111-1111-1111-1111-111111111111"
const APP = "22222222-2222-2222-2222-222222222222"
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, "fixtures/ncsc", name)))
const EDGE = "2025-NCSC-Edge.json"
const APP_CONTROL = "2025-NCSC-App-Control-for-Business.json"
const ncsc = frameworks.find(f => f.id === "ncsc-dsg")!
afterEach(() => vi.unstubAllGlobals())

describe("NCSC Device Security Guidance catalog entry", () => {
  it("is an enabled, attributed pack framework with explicit coverage", () => {
    expect(ncsc).toMatchObject({ name: "UK NCSC Device Security Guidance", publisher: "UK National Cyber Security Centre", kind: "Baseline",
      source: "https://github.com/ukncsc/Device-Security-Guidance-Configuration-Packs", comparisonOnly: true })
    expect(ncsc.disabledReason).toBeUndefined()
    expect(ncsc.nativeId).toBeUndefined()
    expect(ncsc.licenseNotice).toBe("Contains NCSC configuration packs, Crown Copyright, licensed under the Apache License 2.0. Modified for comparison. No endorsement by NCSC.")
    expect(ncsc.coverage).toMatch(/Windows Settings Catalog/)
    expect(ncsc.coverage).toMatch(/Apple, Android and ChromeOS guidance is not in Intune policy format and is not assessed/)
    expect(NCSC_NOT_ASSESSED.every(entry => entry.reason.length > 0)).toBe(true)
  })

  it("is free on every plan: loading, assessment and every report format", async () => {
    for (const action of ["load-ncsc", "assess", "workspace-load", "workspace-save", "workspace-pdf", "workspace-csv", "workspace-json"]) {
      expect(requiredFeature("/api/frameworks", { action, frameworkId: "ncsc-dsg", tenantId: TENANT })).toBeNull()
      for (const plan of ["community", "pro", "msp"] as const) {
        const request = new Request("http://tenuvault.internal/api/frameworks", { method: "POST", body: JSON.stringify({ action, frameworkId: "ncsc-dsg", tenantId: TENANT }) })
        expect(await planGuard(async () => plan)(request)).toBeNull()
      }
    }
    expect(allows("community", "baselineAllPlatforms")).toBe(false)
  })

  it("ships a copy of the Apache License 2.0 with attribution and the pinned commit", () => {
    const text = readFileSync(resolve(__dirname, "../resources/licenses/ncsc-device-security-guidance-LICENSE.txt"), "utf8")
    expect(text).toContain("Crown Copyright")
    expect(text).toContain(NCSC_COMMIT)
    expect(text).toContain("Apache License")
    expect(text).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")
    expect(text).toMatch(/not affiliated with or endorsed by the NCSC/)
  })
})

describe("NCSC pack files", () => {
  it("parses the real UTF-16 Settings Catalog exports with the existing parser", () => {
    const edge = parseNcscFile(EDGE, fixture(EDGE))
    expect(edge).toHaveLength(1)
    expect(edge[0]).toMatchObject({ name: "2025-NCSC-Edge", platforms: "windows10", technologies: "mdm" })
    expect(edge[0]!.settings).toHaveLength(6)
    const appControl = parseNcscFile(APP_CONTROL, fixture(APP_CONTROL))
    expect(appControl[0]!.settings).toHaveLength(1)
    expect(appControl[0]!.templateReference?.templateId).toBe("4321b946-b76b-4450-8afd-769c08b16ffc_1")
    for (const policy of [...edge, ...appControl]) {
      expect(policy.provenance).toMatchObject({ publisher: "UK National Cyber Security Centre", commit: NCSC_COMMIT, license: "Apache-2.0", copyright: "Crown Copyright" })
      expect(String(policy.provenance!.modifications)).toMatch(/removed/)
      const json = JSON.stringify(policy)
      expect(json).not.toMatch(/"assignments"|"roleScopeTagIds"|"@odata.context"|"id":/)
      for (const setting of policy.settings) expect(setting.settingInstance).toHaveProperty("@odata.type")
    }
  })

  it("rejects changed bytes, unknown files and unsupported encodings", () => {
    const tampered = fixture(EDGE); tampered[100] = tampered[100]! ^ 1
    expect(() => parseNcscFile(EDGE, tampered)).toThrow("does not match the pinned NCSC source")
    expect(() => parseNcscFile("2025-NCSC-Other.json", fixture(EDGE))).toThrow("Unexpected NCSC pack file")
    expect(() => decodePackFile(new Uint8Array([0xfe, 0xff, 0, 0x7b]))).toThrow("encoding")
    expect(decodePackFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBe("{}")
    expect(decodePackFile(new TextEncoder().encode("{\"a\":1}"))).toBe("{\"a\":1}")
  })

  it("compares loaded policies by setting definition", () => {
    const pack = parseNcscFile(EDGE, fixture(EDGE))
    expect(comparePolicies(pack, []).every(f => f.status === "Missing")).toBe(true)
    const findings = comparePolicies(pack, [{ ...pack[0]!, id: "33333333-3333-3333-3333-333333333333", name: "Edge hardening" }])
    expect(findings.every(f => f.status === "Present")).toBe(true)
  })
})

describe("NCSC loader", () => {
  it("fetches only the fixed file list at the pinned commit and fails as a whole", async () => {
    const urls: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url))
      return String(url).endsWith(EDGE) ? new Response(fixture(EDGE)) : new Response("missing", { status: 404 })
    }) as unknown as typeof fetch
    await expect(loadNcsc(fetcher)).rejects.toThrow("No pack was loaded")
    const prefix = `https://raw.githubusercontent.com/ukncsc/Device-Security-Guidance-Configuration-Packs/${NCSC_COMMIT}/Microsoft/Windows/MDM/Configurations/SettingsCatalog/`
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(Object.keys(NCSC_SETTINGS_CATALOG).map(file => prefix + encodeURIComponent(file))).toContain(url)
  })

  it("rejects an oversized or substituted file", async () => {
    const big = vi.fn(async () => new Response("x", { headers: { "content-length": "5000000" } })) as unknown as typeof fetch
    await expect(loadNcsc(big)).rejects.toThrow("size limit")
    const substituted = vi.fn(async () => new Response(fixture(EDGE))) as unknown as typeof fetch
    await expect(loadNcsc(substituted)).rejects.toThrow("does not match")
  })

  it("stops reading an oversized body at the limit instead of buffering it whole", async () => {
    const states: Array<{ pulled: number; cancelled: boolean }> = []
    const chunk = new Uint8Array(100_000).fill(120)
    const endless = vi.fn(async () => {
      const state = { pulled: 0, cancelled: false }
      states.push(state)
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulled += chunk.byteLength
          if (state.pulled >= 5_000_000) controller.close()
          else controller.enqueue(chunk)
        },
        cancel() { state.cancelled = true },
      }))
    }) as unknown as typeof fetch
    await expect(loadNcsc(endless)).rejects.toThrow("size limit")
    expect(states.some((state) => state.cancelled)).toBe(true)
    for (const state of states) expect(state.pulled).toBeLessThanOrEqual(2_000_000)
  })

  it("maps a failed load to a 502 through the framework route handler, ignoring request input", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }))
    vi.stubGlobal("fetch", fetch)
    await expect(handleFramework({ action: "load-ncsc", url: "https://example.com/evil.json" })).rejects.toMatchObject({ status: 502 })
    for (const [url] of fetch.mock.calls as unknown as [string][]) expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/ukncsc\//)
  })
})

describe("NCSC comparison only", () => {
  it("assesses without writes and refuses policy creation, with or without a framework ID", async () => {
    const posts: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "test" })
      if (init?.method === "POST") posts.push(url)
      return Response.json({ value: [] })
    }))
    const policies = parseNcscFile(EDGE, fixture(EDGE))
    const run = await handleFramework({ action: "assess", tenantId: TENANT, appId: APP, frameworkId: "ncsc-dsg", reference: "NCSC 2025", policies: JSON.parse(JSON.stringify(policies)) as Json }) as { runId: string; findings: { status: string }[] }
    expect(run.findings.every(f => f.status === "Missing")).toBe(true)
    for (const frameworkId of [undefined, "ncsc-dsg", "custom"]) {
      await expect(handleFramework({ action: "create", ...(frameworkId ? { frameworkId } : {}), tenantId: TENANT, appId: APP, runId: run.runId, keys: ["0:0"], confirmUnassigned: true }))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining("comparison and reports only") })
    }
    expect(posts.filter(url => url.includes("graph.microsoft.com"))).toHaveLength(0)
  })

  it("states the NCSC license notice in every saved assessment export", () => {
    const policies = parseNcscFile(EDGE, fixture(EDGE))
    const findings = comparePolicies(policies, [])
    const saved = { assessment: { runId: "run-1", tenantId: TENANT, frameworkId: "ncsc-dsg", reference: "NCSC 2025", assessedAt: "2026-09-30T10:00:00Z", policyCount: 0, findings }, policies }
    const context = { exportedAt: "2026-09-30T11:00:00Z", tenantName: "Contoso" }
    expect(workspaceReportHeader(saved, context).notice).toContain(ncsc.licenseNotice)
    expect(workspaceReportHeader(saved, context).framework.name).toBe("UK NCSC Device Security Guidance")
    expect(workspaceExportCSV(saved, context)).toContain("Apache License 2.0")
    const json = JSON.parse(workspaceExportJSON(saved, context)) as { report: { notice: string }; result: { policies: { provenance: { license: string } }[] } }
    expect(json.report.notice).toContain("No endorsement by NCSC")
    expect(json.result.policies[0]!.provenance.license).toBe("Apache-2.0")
    const other = { ...saved, assessment: { ...saved.assessment, frameworkId: "custom" } }
    expect(workspaceReportHeader(other, context).notice).not.toContain("NCSC")
  })
})
