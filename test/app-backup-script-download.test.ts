import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { downloadAppScript } from "../src/main/app-backup/script-download"
import type { IntuneAppScript } from "../src/shared/app-sources/types"

const script: IntuneAppScript = { id: "a".repeat(64), name: "Install.ps1", kind: "install", content: "Write-Output 'Grüße'", signatureCheck: false, runAs32Bit: false }
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
it("saves script text with Windows PowerShell Unicode encoding and preserves an existing destination", async () => {
  const folder = await mkdtemp(join(tmpdir(), "app-script-test-")); folders.push(folder)
  const destination = join(folder, "install.ps1"), pick = vi.fn(async () => destination)
  expect(await downloadAppScript(script, pick)).toBe(true)
  expect(pick).toHaveBeenCalledWith("install-script.ps1")
  expect(await readFile(destination, "utf8")).toBe(`\uFEFF${script.content}`)
  await writeFile(destination, "existing")
  await expect(downloadAppScript(script, pick)).rejects.toThrow("existing files are preserved")
  expect(await readFile(destination, "utf8")).toBe("existing")
})
it("treats picker cancellation neutrally and rejects unavailable scripts before the picker", async () => {
  const pick = vi.fn(async () => null)
  expect(await downloadAppScript(script, pick)).toBe(false)
  pick.mockClear()
  await expect(downloadAppScript({ ...script, content: null }, pick)).rejects.toThrow("unavailable")
  expect(pick).not.toHaveBeenCalled()
})
