import { expect, it, vi } from "vitest"
import { restoreCapability, typeForFolder } from "../src/shared/intune/registry"
import { restoreMatrixRow } from "../src/shared/intune/restore-matrix"
import { moduleForFolder } from "../src/shared/services/modules"

vi.hoisted(() => vi.stubGlobal("__TV_LAB_EXPANDED_ENTRA__", true))

it("opens expanded Entra coverage independently of privileged restore in lab builds", () => {
  expect(moduleForFolder("CrossTenantAccessPolicy")?.area.id).toBe("externalIdentities")
  expect(typeForFolder("CrossTenantAccessPolicy")).toBeDefined()
  expect(restoreMatrixRow("CrossTenantAccessPolicy")).toBeDefined()
  expect(restoreCapability(typeForFolder("Applications")!)).toBe("none")
})
