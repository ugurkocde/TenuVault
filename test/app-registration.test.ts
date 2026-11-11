import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { setupIdsFromClipboard, CONSENT_ROLES, DESKTOP_APP_PERMISSIONS, parseSetupOutput, setupHandoffText, SETUP_SCRIPT_DOWNLOAD_URL } from "../src/shared/app-registration"
import { licenseKeyFromClipboard } from "../src/main/license/clipboard-key"

const script = readFileSync(new URL("../resources/New-TenuVaultDesktopApp.ps1", import.meta.url), "utf8")

describe("the app registration shown in the guided setup", () => {
  it("lists exactly the default permissions the setup script grants", () => {
    const graph = /AppId\s*=\s*"00000003-0000-0000-c000-000000000000"\s*Scopes\s*=\s*@\(([^)]*)\)/.exec(script)?.[1] ?? ""
    const scopes = [...graph.matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(DESKTOP_APP_PERMISSIONS[0]!.permissions).toEqual(scopes)
    for (const entry of DESKTOP_APP_PERMISSIONS.slice(1)) {
      expect(script).toContain(`Name   = "${entry.api}"`)
      expect(entry.permissions).toEqual(["user_impersonation"])
    }
  })

  it("names every role the script header allows", () => {
    const header = script.replace(/\s+/g, " ")
    for (const role of CONSENT_ROLES) expect(header).toContain(role)
  })
})

describe("parseSetupOutput", () => {
  const tenant = "8C6F2B1E-4D3A-4F7B-9E21-6A5D0C3B7F14"
  const client = "5c3b8e21-7a4f-4d19-9c6e-2f81d0a4b7e3"

  it("reads both IDs from the script's closing lines", () => {
    const output = `Done. Copy the two lines below and paste them into the Sign in step of Set up TenuVault:\n  Tenant id:                ${tenant}\n  Application (client) id:  ${client}\n`
    expect(parseSetupOutput(output)).toEqual({ tenantId: tenant.toLowerCase(), clientId: client })
  })

  it("accepts tabs, other spacing and a lone client id line", () => {
    expect(parseSetupOutput(`tenant ID:\t${tenant}`)).toEqual({ tenantId: tenant.toLowerCase() })
    expect(parseSetupOutput(`Client id: ${client}`)).toEqual({ clientId: client })
  })

  it("does not take the tenant ID for the client ID", () => {
    expect(parseSetupOutput(`Tenant id: ${tenant}`).clientId).toBeUndefined()
    expect(parseSetupOutput("no ids here")).toEqual({})
  })
})

describe("setupHandoffText", () => {
  it("gives another administrator everything they need, without an em dash", () => {
    const text = setupHandoffText()
    expect(text).toContain(SETUP_SCRIPT_DOWNLOAD_URL)
    expect(text).toContain("Tenant id")
    expect(text).toContain("Application (client) id")
    expect(text).toContain("DeviceManagementConfiguration.ReadWrite.All")
    expect(text).toContain("-AllowedGroupId")
    expect(text).not.toContain("\u2014")
  })
})

describe("licenseKeyFromClipboard", () => {
  it("returns a copied TenuVault key, trimmed", () => {
    expect(licenseKeyFromClipboard("  TENU-ABCD-1234-EFGH\n")).toBe("TENU-ABCD-1234-EFGH")
  })

  it("ignores anything else on the clipboard", () => {
    for (const text of ["", "hello", "Your key: TENU-ABCD-1234", "TENU-AB", "TENU-ABCD 1234", `TENU-${"A".repeat(200)}`, 42, null]) {
      expect(licenseKeyFromClipboard(text)).toBeNull()
    }
  })
})

describe("setupIdsFromClipboard", () => {
  it("returns only a complete ID pair", () => {
    const tenantId = "11111111-1111-4111-8111-111111111111"
    const clientId = "22222222-2222-4222-8222-222222222222"
    expect(setupIdsFromClipboard(`private text\nTenant id: ${tenantId}\nApplication (client) id: ${clientId}`)).toEqual({ tenantId, clientId })
    for (const value of [null, 42, "private text", `Tenant id: ${tenantId}`]) expect(setupIdsFromClipboard(value)).toBeNull()
  })
})
