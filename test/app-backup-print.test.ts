import { expect, it, vi } from "vitest"
import { readFile, lstat } from "node:fs/promises"
import type { BrowserWindow } from "electron"
import { printAppDetails } from "../src/main/app-backup/print"
it.each(["success","cancel","failure"])("cleans its private print document after %s",async outcome=>{
 let file=""
 const page={webContents:{setWindowOpenHandler:vi.fn(),on:vi.fn(),print:vi.fn((_options:unknown,callback:(success:boolean,reason:string)=>void)=>callback(outcome==="success",outcome==="cancel"?"Print job canceled":"Printer unavailable"))},loadFile:vi.fn(async(path:string)=>{file=path;expect(await readFile(file,"utf8")).toContain("App details")}),destroy:vi.fn()}
 const action=printAppDetails("<html>App details</html>",()=>page as unknown as BrowserWindow)
 if(outcome==="failure")await expect(action).rejects.toThrow("Check the printer")
 else expect(await action).toBe(outcome==="success")
 expect(page.destroy).toHaveBeenCalledOnce();await expect(lstat(file)).rejects.toMatchObject({code:"ENOENT"})
})
