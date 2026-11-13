import { createRequire } from "node:module"
import { join } from "node:path"
import { expect, it, vi } from "vitest"

const signCaptureHelper = createRequire(import.meta.url)("../scripts/sign-capture-helper.cjs")
function context(platform = "win32", signed = true) {
  return { electronPlatformName: platform, appOutDir: "/build/win-unpacked", packager: {
    platformSpecificBuildOptions: { azureSignOptions: signed ? { endpoint: "configured" } : undefined },
    signIf: vi.fn(async () => true),
  } }
}
it("signs the actual packaged helper for every architecture before installer creation", async () => {
  for (const folder of ["win-unpacked", "win-arm64-unpacked"]) {
    const value = context()
    value.appOutDir = join("build", folder)
    await signCaptureHelper(value)
    expect(value.packager.signIf).toHaveBeenCalledExactlyOnceWith(join(value.appOutDir, "resources", "app-backup", "TenuVault.Capture.exe"))
  }
})
it("leaves unsigned PR packages and non-Windows builds unsigned", async () => {
  for (const value of [context("win32", false), context("darwin"), context("linux")]) {
    await signCaptureHelper(value)
    expect(value.packager.signIf).not.toHaveBeenCalled()
  }
})
it("stops packaging if the configured signer skips or fails the helper", async () => {
  const value = context()
  value.packager.signIf.mockResolvedValueOnce(false)
  await expect(signCaptureHelper(value)).rejects.toThrow("not signed")
  value.packager.signIf.mockRejectedValueOnce(new Error("signing failed"))
  await expect(signCaptureHelper(value)).rejects.toThrow("signing failed")
})
