import { beforeEach, expect, it, vi } from "vitest"
import type { TenuVaultPreloadBridge } from "../src/shared/ipc"
import { TRIAL_USED_MESSAGE } from "../src/shared/constants"

const state = vi.hoisted(() => ({ invoke: vi.fn(), bridge: null as TenuVaultPreloadBridge | null }))
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: (_name: string, bridge: TenuVaultPreloadBridge) => { state.bridge = bridge } }, ipcRenderer: { invoke: state.invoke } }))
import "../src/preload"

beforeEach(() => { state.invoke.mockReset() })
it("shows the trial_used text without Electron's custom error name", async () => {
  state.invoke.mockRejectedValue(new Error(`Error invoking remote method 'license:setKey': LicenseDenied: ${TRIAL_USED_MESSAGE}`))
  await expect(state.bridge!.license.setKey("TENU-TRIAL-KEY-0001")).rejects.toMatchObject({ message: TRIAL_USED_MESSAGE })
})
it.each(["LicenseDenied: This tenant already has an organization license.", "Error: unavailable", "LicenseDenied: This license key is not valid for TenuVault."])("removes transport and license error names for %s", async message => {
  state.invoke.mockRejectedValue(new Error(`Error invoking remote method 'license:setKey': ${message}`))
  await expect(state.bridge!.license.setKey("TENU-TRIAL-KEY-0001")).rejects.toMatchObject({ message: message.replace(/^(?:Error|LicenseDenied): /, "") })
})
