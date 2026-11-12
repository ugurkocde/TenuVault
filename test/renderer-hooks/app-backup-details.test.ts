import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const api=vi.hoisted(()=>({details:vi.fn(),printDetails:vi.fn(async()=>true),downloadScript:vi.fn(async()=>true),openExternal:vi.fn()}))
vi.mock("../../src/renderer/lib/bridge",()=>({bridge:{appSources:api,app:{openExternal:api.openExternal}}}))
import { AppDetailsDialog } from "../../src/renderer/features/app-backup/AppDetailsDialog"
const app={id:"22222222-2222-2222-2222-222222222222",name:"Finance",publisher:"Contoso",version:"4.2"}
const details={...app,description:"Original app description <script>not HTML</script>",createdAt:null,modifiedAt:null,fileName:"Finance.intunewin",packageBytes:1000,installContext:"system",installCommand:"setup.exe /quiet",uninstallCommand:"setup.exe /remove",restartBehavior:"suppress",maxRunTimeMinutes:60,scripts:[{id:"a".repeat(64),name:"Install.ps1",kind:"install",content:"Write-Output 'hello'",signatureCheck:false,runAs32Bit:false}],scriptWarning:null,assignments:[],assignmentWarning:null,rules:[]}
let root:Root|undefined
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.innerHTML="";vi.clearAllMocks()})
async function click(text:string){const button=[...document.querySelectorAll("button")].find(button=>button.textContent?.trim()===text)!;expect(button).toBeTruthy();await act(async()=>button.click())}
it("shows real app metadata and scripts as text, with native printing",async()=>{
 api.details.mockResolvedValue(details)
 const node=document.createElement("div");document.body.append(node);root=createRoot(node)
 await act(async()=>root!.render(createElement(AppDetailsDialog,{tenant:"tenant",app,onClose:vi.fn(),onBackup:vi.fn(),returnFocus:vi.fn()})))
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain("4.2")
 expect(document.querySelector('[role="dialog"] script')).toBeNull()
 await click("Installation");expect(document.body.textContent).toContain("setup.exe /quiet")
 await click("Scripts (1)");expect(document.body.textContent).toContain("Write-Output 'hello'")
 expect([...document.querySelectorAll("button")].some(button=>button.textContent?.includes("Save PDF"))).toBe(false)
 await click("Download");expect(api.downloadScript).toHaveBeenLastCalledWith("tenant",app.id,"a".repeat(64))
 expect(document.body.textContent).toContain("Script saved. It has not been executed.")
 await click("Print");expect(api.printDetails).toHaveBeenLastCalledWith("tenant",app.id)
 expect(document.body.textContent).toContain("App details sent to the printer")
})
it("ignores a late detail response after the dialog is removed",async()=>{
 let finish!:(value:typeof details)=>void;api.details.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 const node=document.createElement("div");document.body.append(node);root=createRoot(node)
 await act(async()=>root!.render(createElement(AppDetailsDialog,{tenant:"tenant",app,onClose:vi.fn(),onBackup:vi.fn(),returnFocus:vi.fn()})))
 await act(async()=>root!.render(null));await act(async()=>finish(details))
 expect(document.querySelector('[role="dialog"]')).toBeNull()
})
