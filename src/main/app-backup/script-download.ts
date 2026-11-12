import { open, rm } from "node:fs/promises"
import type { IntuneAppScript } from "../../shared/app-sources/types"

/** Save only the script returned by the main-owned metadata reader; never execute it. */
export async function downloadAppScript(script: IntuneAppScript, pick: (fileName: string) => Promise<string | null>): Promise<boolean> {
  if (script.content === null) throw new Error("This script's content is unavailable.")
  const destination = await pick(`${script.kind}-script.ps1`)
  if (!destination) return false
  let file
  try { file = await open(destination, "wx", 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A file with that name already exists. Choose a new name; existing files are preserved.")
    throw error
  }
  try {
    // UTF-8 BOM preserves non-ASCII PowerShell text in Windows PowerShell 5.1.
    await file.writeFile(script.content.startsWith("\uFEFF") ? script.content : `\uFEFF${script.content}`)
    await file.sync()
  } catch (error) {
    await file.close()
    await rm(destination, { force: true })
    throw error
  }
  await file.close()
  return true
}
