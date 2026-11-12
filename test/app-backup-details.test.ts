import { describe, it, expect, vi } from "vitest"
import { readAppBackupDetails } from "../src/main/app-backup/app-details"
import { appIcon, appMetadataGet } from "../src/main/app-backup/graph-read"
import { appDetailsHtml } from "../src/shared/app-sources/details-report"
const tenant="11111111-1111-1111-1111-111111111111", appId="22222222-2222-2222-2222-222222222222"
const row={"@odata.type":"#microsoft.graph.win32LobApp",id:appId,displayName:"Finance",publisher:"Contoso",displayVersion:"2.4",description:"<script>alert('x')</script>",installCommandLine:'setup.exe /quiet',uninstallCommandLine:'setup.exe /remove',committedContentVersion:"1",activeInstallScript:{targetId:"script"},installExperience:{runAsAccount:"system",deviceRestartBehavior:"suppress",maxRunTimeInMinutes:60},rules:[{"@odata.type":"#microsoft.graph.win32LobAppPowerShellScriptRule",ruleType:"detection",scriptContent:Buffer.from("Write-Output 'detected'").toString("base64")}]}
function fetcher(options:{scriptFail?:boolean;foreignPage?:boolean}={}) {
 return vi.fn(async(input:Parameters<typeof fetch>[0],_options?:RequestInit)=> {
  const url=String(input)
  if(url.endsWith('/assignments'))return Response.json({value:[{intent:"required",target:{"@odata.type":"#microsoft.graph.groupAssignmentTarget",groupId:tenant}}]})
  if(url.endsWith('/scripts'))return options.scriptFail?new Response('denied',{status:403}):Response.json({value:[{id:"script",displayName:"Install.ps1",content:Buffer.from("Write-Output '<install>'").toString('base64')}],...(options.foreignPage?{"@odata.nextLink":"https://evil.test/beta/deviceAppManagement/mobileApps/"+appId+"/microsoft.graph.win32LobApp/contentVersions/1/scripts"}:{})})
  return Response.json(row)
 })
}
describe("read-only Intune app details",()=>{
 it("loads bounded program/script/assignment metadata through tenant-bound beta reads",async()=>{
  const token=vi.fn(async()=>"token"),get=fetcher(),details=await readAppBackupDetails(tenant,appId,token,get)
  expect(details).toMatchObject({id:appId,version:"2.4",installContext:"system",installCommand:"setup.exe /quiet",assignments:[{intent:"required",groupId:tenant}],scriptWarning:null})
  expect(details.scripts.every(s=>/^[a-f0-9]{64}$/.test(s.id))).toBe(true)
  expect(details.scripts.map(s=>s.content)).toEqual(expect.arrayContaining(["Write-Output 'detected'","Write-Output '<install>'"]))
  expect(token).toHaveBeenCalledExactlyOnceWith(tenant)
  for(const [url,options] of get.mock.calls as unknown as Array<[string,RequestInit]>) {expect(url).toContain('https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/');expect(options).toMatchObject({method:"GET",redirect:"error"})}
  expect(String(get.mock.calls[0]![0])).toContain('microsoft.graph.win32LobApp/displayVersion')
 })
 it.each(["permission","foreign-page"])("keeps base details available after a script %s failure",async mode=>{
  const get=fetcher({scriptFail:mode==="permission",foreignPage:mode==="foreign-page"})
  const details=await readAppBackupDetails(tenant,appId,async()=>"token",get)
  expect(details.version).toBe("2.4");expect(details.scriptWarning).toBeTruthy();expect(details.assignments).toHaveLength(1)
  expect(get.mock.calls.every(([url])=>String(url).startsWith('https://graph.microsoft.com/beta/'))).toBe(true)
 })
 it("rejects missing auth, malformed IDs and a different app/type",async()=>{
  const get=vi.fn(async()=>Response.json({...row,id:tenant})),token=vi.fn(async()=>"token")
  await expect(readAppBackupDetails(tenant,"invalid",token,get)).rejects.toThrow();expect(token).not.toHaveBeenCalled()
  await expect(readAppBackupDetails(tenant,appId,async()=>"",get)).rejects.toThrow('Reconnect');expect(get).not.toHaveBeenCalled()
  await expect(readAppBackupDetails(tenant,appId,token,get)).rejects.toThrow('selected tenant')
  get.mockResolvedValueOnce(Response.json({...row,"@odata.type":"#microsoft.graph.macOSDmgApp"}))
  await expect(readAppBackupDetails(tenant,appId,token,get)).rejects.toThrow('selected tenant')
 })
 it("does not confuse an assignment read failure with no assignments",async()=>{
  const get=fetcher();get.mockImplementationOnce(async()=>Response.json({...row,activeInstallScript:null})).mockResolvedValueOnce(new Response('denied',{status:403}))
  const details=await readAppBackupDetails(tenant,appId,async()=>"token",get)
  expect(details.assignments).toBeNull();expect(details.assignmentWarning).toContain('403')
 })
 it.each(["utf8","utf8-bom","utf16le","utf16be"])("decodes a %s script without corrupting Unicode",async encoding=>{
  const text="Write-Output 'Grüße 日本語'", utf16=Buffer.from(text,"utf16le")
  const bytes=encoding==="utf8"?Buffer.from(text):encoding==="utf8-bom"?Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(text)]):encoding==="utf16le"?Buffer.concat([Buffer.from([0xff,0xfe]),utf16]):Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from(utf16).swap16()])
  const get=fetcher();get.mockResolvedValueOnce(Response.json({...row,activeInstallScript:null,rules:[{"@odata.type":"#microsoft.graph.win32LobAppPowerShellScriptRule",ruleType:"detection",scriptContent:bytes.toString("base64")}]}))
  const details=await readAppBackupDetails(tenant,appId,async()=>"token",get)
  expect(details.scripts[0]!.content).toBe(text);expect(details.scriptWarning).toBeNull()
 })
 it.each([[0xc3,0x28],[0xff,0xfe,0x41],[0xff,0xfe,0,0,0x41,0,0,0],[0,0,0xfe,0xff,0,0,0,0x41],[0x41,0,0x42,0]])("refuses invalid or unsupported script bytes %j instead of offering corrupted text",async(...values)=>{
  const get=fetcher();get.mockResolvedValueOnce(Response.json({...row,activeInstallScript:null,rules:[{"@odata.type":"#microsoft.graph.win32LobAppPowerShellScriptRule",scriptContent:Buffer.from(values).toString("base64")}]}))
  const details=await readAppBackupDetails(tenant,appId,async()=>"token",get)
  expect(details.scripts[0]!.content).toBeNull();expect(details.scriptWarning).toContain("unsupported text encoding")
 })
 it("escapes app-controlled text and marks truncated print scripts",async()=>{
  const details=await readAppBackupDetails(tenant,appId,async()=>"token",fetcher())
  details.name='<img src=x onerror=alert(1)>';details.scripts[0]!.content='x'.repeat(9000)
  const html=appDetailsHtml(details)
  expect(html).not.toContain('<img src=x');expect(html).not.toContain("<script>alert")
  expect(html).toContain('&lt;script&gt;');expect(html).toContain('Print preview truncated')
  expect(html).toContain("default-src 'none'")
 })
 it("accepts only bounded raster logo data and never remote or SVG content",()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')
  expect(appIcon({type:"image/png",value:png})).toBe('data:image/png;base64,'+png)
  for(const logo of [{type:"image/svg+xml",value:Buffer.from('<svg onload=alert(1)>').toString('base64')},{type:"image/png",value:'https://evil.test/logo'},{type:"image/png",value:'a'.repeat(180001)}])expect(appIcon(logo)).toBeNull()
 })
 it.each(["https://evil.test/beta/deviceAppManagement/mobileApps","https://graph.microsoft.com/v1.0/deviceAppManagement/mobileApps"])("refuses untrusted metadata URLs %s before sending a token",async url=>{
  const get=vi.fn();await expect(appMetadataGet(url,'token',get)).rejects.toThrow('Invalid');expect(get).not.toHaveBeenCalled()
 })
})
