import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

it("does not expose local file attachment or unauthenticated capture through the renderer bridge", async () => {
  const files = await Promise.all(["src/main/index.ts", "src/preload/index.ts", "src/shared/app-sources/types.ts", "src/renderer/pages/AppBackupPage.tsx", "src/renderer/features/app-backup/IntuneAppsView.tsx"].map(path => readFile(path, "utf8")))
  expect(files.join("\n")).not.toMatch(/appSources:attach|appSources\.attach|Choose installer file|Attach an existing Win32 package/)
  // The new download/storage seam must remain internal until its authenticated
  // device adapter exists. A label from the renderer cannot mint capture provenance.
  expect(files[0]).not.toContain("downloadCapturedContent")
  const preload = files[1]!.slice(files[1]!.indexOf("appSources: {"), files[1]!.indexOf("  api:"))
  expect(preload).not.toMatch(/capture:|encryptionKey|downloadUrl/)
})
