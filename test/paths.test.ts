import { describe, expect, it } from "vitest"
import { resolveApiPath } from "../src/renderer/lib/fetch-bridge"
import { resolveHref } from "../src/renderer/shims/paths"

describe("resolveHref", () => {
  it("keeps portal routes inside the app", () => {
    expect(resolveHref("/portal/dashboard")).toEqual({ kind: "internal", path: "/portal/dashboard" })
    expect(resolveHref("/portal/backup?tenant=1")).toEqual({ kind: "internal", path: "/portal/backup?tenant=1" })
  })

  it("keeps license routes inside the app", () => {
    expect(resolveHref("/license")).toEqual({ kind: "internal", path: "/license" })
    expect(resolveHref("/license?tenant=1#activation")).toEqual({ kind: "internal", path: "/license?tenant=1#activation" })
  })

  it("matches app routes at segment boundaries", () => {
    expect(resolveHref("/portalfoo")).toEqual({ kind: "external", url: "https://tenuvault.com/portalfoo" })
    expect(resolveHref("/licensefoo")).toEqual({ kind: "external", url: "https://tenuvault.com/licensefoo" })
  })

  it("sends the website home page to the dashboard", () => {
    expect(resolveHref("/")).toEqual({ kind: "internal", path: "/portal/dashboard" })
  })

  it("opens website pages and absolute URLs externally", () => {
    expect(resolveHref("/docs/getting-started")).toEqual({ kind: "external", url: "https://tenuvault.com/docs/getting-started" })
    expect(resolveHref("https://intune.microsoft.com")).toEqual({ kind: "external", url: "https://intune.microsoft.com" })
  })
})

describe("resolveApiPath", () => {
  const windowsPage = "file:///C:/Program%20Files/TenuVault/resources/app.asar/out/renderer/index.html#/portal/backup"
  const macPage = "file:///Applications/TenuVault.app/Contents/Resources/app.asar/out/renderer/index.html"

  it("keeps relative API paths", () => {
    expect(resolveApiPath("/api/list-backups?x=1", windowsPage)).toBe("/api/list-backups?x=1")
  })

  it("strips the Windows drive letter from resolved file URLs", () => {
    expect(resolveApiPath("file:///C:/api/templates/azure-resources", windowsPage)).toBe("/api/templates/azure-resources")
  })

  it("handles origin-prefixed URLs built from location.origin", () => {
    expect(resolveApiPath("file:///api/templates/runbook-script", macPage)).toBe("/api/templates/runbook-script")
    expect(resolveApiPath("http://localhost:5173/api/x", "http://localhost:5173/#/portal")).toBe("/api/x")
  })

  it("ignores other files and other origins", () => {
    expect(resolveApiPath("./assets/logo.svg", macPage)).toBeNull()
    expect(resolveApiPath("https://graph.microsoft.com/api/x", macPage)).toBeNull()
  })
})
