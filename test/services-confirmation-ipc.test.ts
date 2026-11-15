import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import { expect, it, vi } from "vitest"
import { ModuleSettings } from "../src/main/services/settings"
import { MODULES } from "../src/shared/services/modules"
import { memoryStore } from "./helpers"

it("refuses direct services:setEnabled IPC without confirmation before persisting Intune off", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8")
  const source = main.slice(main.indexOf('  handleTrusted("services:setEnabled"'), main.indexOf('  // What TenuVault asks for at setup'))
  let handler!: (...args: unknown[]) => unknown
  const moduleSettings = new ModuleSettings(memoryStore())
  const servicesFor = vi.fn(() => ({}))
  new Function("handleTrusted", "moduleSettings", "servicesFor", "MODULES", transformSync(source, { loader: "ts" }).code)(
    (_channel: string, fn: typeof handler) => { handler = fn }, moduleSettings, servicesFor, MODULES,
  )
  for (const confirmation of [undefined, false, {}, { confirmed: false }, { confirmed: "true" }]) {
    expect(() => handler({}, "tenant", "client", "intune", false, confirmation)).toThrow("Confirm turning off Intune")
    expect(moduleSettings.get("tenant").intune.enabled).toBe(true)
    expect(servicesFor).not.toHaveBeenCalled()
  }
  handler({}, "tenant", "client", "intune", false, { confirmed: true })
  expect(moduleSettings.get("tenant").intune.enabled).toBe(false)
  expect(servicesFor).toHaveBeenCalledOnce()
  handler({}, "tenant", "client", "intune", true)
  expect(moduleSettings.get("tenant").intune.enabled).toBe(true)
  expect(() => handler({}, "tenant", "client", "conditionalAccess", false)).not.toThrow()
})

it("publishes account changes through preload so Services can invalidate old sign-in verification without consuming health acknowledgements", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8")
  const preload = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8")
  const callback = main.slice(main.indexOf("const accounts = accountStore("), main.indexOf("// MSAL token traffic"))
  expect(callback).toContain('mainWindow?.webContents.send("auth:accountsChanged", tenantId)')
  expect(preload).toContain('onAccountsChanged: (listener) => subscribe<string>("auth:accountsChanged", listener)')
})
