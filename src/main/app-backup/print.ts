import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron"
import { REPORT_WINDOW } from "../report-export"

/** Native printer dialog in an isolated, script-free document window. */
export async function printAppDetails(html: string, open: (options: BrowserWindowConstructorOptions) => BrowserWindow): Promise<boolean> {
  const folder = await mkdtemp(join(tmpdir(), "tenuvault-app-details-"))
  let page: BrowserWindow | undefined
  try {
    page = open(REPORT_WINDOW)
    page.webContents.setWindowOpenHandler(() => ({action:"deny"}))
    page.webContents.on("will-navigate", event => event.preventDefault())
    const file = join(folder,"details.html")
    await writeFile(file,html,{mode:0o600})
    await page.loadFile(file)
    return await new Promise<boolean>((resolve,reject)=>page!.webContents.print({silent:false,printBackground:true},(success,reason)=>{
      if (success) resolve(true)
      else if (/cancel/i.test(reason)) resolve(false)
      else reject(new Error("App details could not be printed. Check the printer and retry."))
    }))
  } finally { page?.destroy(); await rm(folder,{recursive:true,force:true}).catch(()=>{}) }
}
