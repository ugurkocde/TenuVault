import { useEffect, useId, useRef, useState } from "react"
import { Printer, ExternalLink, Package, Download } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { bridge } from "../../lib/bridge"
import { adminCenterLink } from "../../../shared/intune/admin-links"
import type { IntuneAppDetails, IntuneBackupApp } from "../../../shared/app-sources/types"

export function AppIcon({ app }: {app: IntuneBackupApp}) {
  return <span className="relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-secondary text-sm font-semibold text-muted-foreground" aria-hidden="true">
    {app.name.slice(0,1).toUpperCase() || <Package className="size-5" />}
    {app.icon && <img src={app.icon} width={36} height={36} alt="" loading="lazy" decoding="async" className="absolute size-9 object-contain" onError={event => {event.currentTarget.hidden=true}} />}
  </span>
}
const friendly = (value: string) => value.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/Rule$/,"rule")
const targets:Record<string,string>={allDevicesAssignmentTarget:"All devices",allLicensedUsersAssignmentTarget:"All users",groupAssignmentTarget:"Included group",exclusionGroupAssignmentTarget:"Excluded group"}
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "Not specified"
function Fields({items}: {items: Array<[string, string | number | null | undefined]>}) {
  return <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">{items.map(([label,value])=><div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-medium">{value ?? "Not specified"}</dd></div>)}</dl>
}

export function AppDetailsDialog({tenant,app,onClose,onBackup,returnFocus}: {tenant:string;app:IntuneBackupApp|null;onClose:()=>void;onBackup:(app:IntuneBackupApp)=>void;returnFocus:()=>void}) {
  const [section,setSection] = useState("overview")
  const tabsId = useId()
  const [details,setDetails] = useState<IntuneAppDetails|null>(null), [error,setError] = useState(""), [loading,setLoading] = useState(false)
  const [printing,setPrinting] = useState(false), [printNotice,setPrintNotice] = useState("")
  const [downloading,setDownloading] = useState<number|null>(null), [downloadNotice,setDownloadNotice] = useState("")
  const sequence=useRef(0), alive=useRef(true)
  async function load() {
    if(!app)return
    const generation=++sequence.current;setLoading(true);setDetails(null);setError("");setPrintNotice("")
    try {const result=await bridge.appSources.details(tenant,app.id);if(alive.current&&sequence.current===generation)setDetails(result)}
    catch(e){if(alive.current&&sequence.current===generation)setError(e instanceof Error?e.message:"App details could not be loaded. Refresh and retry.")}
    finally{if(alive.current&&sequence.current===generation)setLoading(false)}
  }
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;sequence.current++}},[tenant,app?.id])
  async function print() {
    if(!app)return
    const generation=sequence.current;setPrinting(true);setPrintNotice("")
    try {const done=await bridge.appSources.printDetails(tenant,app.id);if(alive.current&&generation===sequence.current)setPrintNotice(done?"App details sent to the printer.":"Print cancelled.")}
    catch(e){if(alive.current&&generation===sequence.current)setPrintNotice(e instanceof Error?e.message:"Printing failed. Check the printer and retry.")}
    finally{if(alive.current&&generation===sequence.current)setPrinting(false)}
  }
  async function download(index: number) {
    if (!app) return
    const generation=sequence.current;setDownloading(index);setDownloadNotice("")
    try {const done=await bridge.appSources.downloadScript(tenant,app.id,details!.scripts[index]!.id);if(alive.current&&generation===sequence.current)setDownloadNotice(done?"Script saved. It has not been executed.":"Download cancelled.")}
    catch(e){if(alive.current&&generation===sequence.current)setDownloadNotice(e instanceof Error?e.message:"Script could not be saved. Retry with a new filename.")}
    finally{if(alive.current&&generation===sequence.current)setDownloading(null)}
  }
  return <Dialog open={!!app} onOpenChange={open=>{if(!open)onClose()}}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[920px]" onCloseAutoFocus={event=>{event.preventDefault();returnFocus()}}>
      <DialogHeader><div className="flex items-start gap-4"><AppIcon app={details??app??{id:"",name:"App",publisher:""}}/><div className="min-w-0"><DialogTitle className="break-words text-2xl">{app?.name}</DialogTitle><DialogDescription className="mt-1">{app?.publisher || "Publisher not specified"} · Win32 app details from Intune</DialogDescription></div></div></DialogHeader>
      {loading&&<p role="status" className="py-8 text-sm text-muted-foreground">Loading app details from the current Microsoft session…</p>}
      {error&&<div role="alert" className="rounded-xl bg-secondary p-4 text-sm"><p>{error}</p><Button variant="outline" className="mt-3" onClick={()=>void load()}>Retry details</Button></div>}
      {details&&<div className="min-w-0">
        <div role="tablist" aria-label="App details sections" className="flex flex-wrap gap-1 rounded-xl bg-secondary p-1">{[["overview","Overview"],["program","Installation"],["scripts",`Scripts (${details.scripts.length})`],["rules","Detection & requirements"],["assignments","Assignments"]].map(([id,label])=><Button key={id} variant={section===id?"default":"ghost"} size="sm" role="tab" id={`${tabsId}-${id}-tab`} aria-selected={section===id} aria-controls={`${tabsId}-${id}-panel`} tabIndex={section===id?0:-1} onClick={()=>setSection(id!)} onKeyDown={event=>{
          const order=["overview","program","scripts","rules","assignments"], at=order.indexOf(id!)
          const next=event.key==="ArrowRight"?order[(at+1)%order.length]:event.key==="ArrowLeft"?order[(at+order.length-1)%order.length]:event.key==="Home"?order[0]:event.key==="End"?order[order.length-1]:null
          if(next){event.preventDefault();setSection(next);document.getElementById(`${tabsId}-${next}-tab`)?.focus()}
        }}>{label}</Button>)}</div>
        <section hidden={section!=="overview"} role="tabpanel" id={`${tabsId}-overview-panel`} aria-labelledby={`${tabsId}-overview-tab`} tabIndex={0} aria-label="overview" className="space-y-6 pt-4">
          <Fields items={[["Version",details.version],["Publisher",details.publisher],["Last modified",date(details.modifiedAt)],["Created",date(details.createdAt)],["Installer filename",details.fileName],["Package size",details.packageBytes===null?null:new Intl.NumberFormat(undefined,{style:"unit",unit:"megabyte",maximumFractionDigits:1}).format(details.packageBytes/1024**2)]]}/>
          <div><h3 className="font-medium">Description</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{details.description||"No description provided in Intune."}</p></div>
          <div><h3 className="font-medium">Intune app ID</h3><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{details.id}</p></div>
        </section>
        <section hidden={section!=="program"} role="tabpanel" id={`${tabsId}-program-panel`} aria-labelledby={`${tabsId}-program-tab`} tabIndex={0} aria-label="program" className="space-y-5 pt-4">
          <Fields items={[["Install context",details.installContext],["Restart behavior",details.restartBehavior],["Maximum runtime (minutes)",details.maxRunTimeMinutes]]}/>
          {[["Install command",details.installCommand],["Uninstall command",details.uninstallCommand]].map(([label,value])=><div key={label}><h3 className="font-medium">{label}</h3><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-secondary p-4 text-xs">{value||"No command line provided. Check the Scripts tab for an active script."}</pre></div>)}
          <p className="text-xs text-muted-foreground">Installation information is read-only. These commands are not executed by viewing or backing up this app.</p>
        </section>
        <section hidden={section!=="scripts"} role="tabpanel" id={`${tabsId}-scripts-panel`} aria-labelledby={`${tabsId}-scripts-tab`} tabIndex={0} aria-label="scripts" className="space-y-4 pt-4">
          {details.scriptWarning&&<p role="status" className="rounded-xl bg-secondary p-4 text-sm">{details.scriptWarning}</p>}
          {!details.scripts.length&&<p className="text-sm text-muted-foreground">No install, uninstall, detection or requirement script content was returned. This app may use command lines instead.</p>}
          {details.scripts.map((script,index)=><section key={`${script.kind}-${index}`}><div className="flex items-center justify-between gap-3"><h3 className="min-w-0 break-words font-medium">{script.name}</h3><Button variant="outline" size="sm" disabled={script.content===null||downloading!==null} aria-label={`Download ${script.name}`} onClick={()=>void download(index)}><Download className="mr-2 size-4" aria-hidden="true"/>{downloading===index?"Saving…":"Download"}</Button></div><p className="mt-1 text-xs text-muted-foreground">{script.kind} · Signature check: {script.signatureCheck===null?"Not specified":script.signatureCheck?"Required":"Not required"} · 32-bit: {script.runAs32Bit===null?"Not specified":script.runAs32Bit?"Yes":"No"}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-secondary p-4 text-xs">{script.content===null?"Script content is unavailable.":script.content||"Empty script"}</pre></section>)}
          <p className="text-xs text-muted-foreground">Scripts are displayed as text and are never run here. Download saves the displayed script as a UTF-8 PowerShell file after checking it still matches Intune; existing files are preserved.</p>{downloadNotice&&<p role="status" className="rounded-xl bg-secondary p-3 text-sm">{downloadNotice}</p>}
        </section>
        <section hidden={section!=="rules"} role="tabpanel" id={`${tabsId}-rules-panel`} aria-labelledby={`${tabsId}-rules-tab`} tabIndex={0} aria-label="rules" className="space-y-4 pt-4">
          {!details.rules.length&&<p className="text-sm text-muted-foreground">No detection or requirement rules returned.</p>}
          {details.rules.map((rule,index)=><section key={index} className="rounded-xl border p-4"><h3 className="font-medium">{rule.purpose||"Rule"} · {friendly(rule.type)}</h3><dl className="mt-3 grid gap-2 text-xs">{Object.entries(rule.properties).map(([key,value])=><div key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3"><dt className="break-words text-muted-foreground">{friendly(key)}</dt><dd className="break-all">{typeof value==="boolean"?(value?"Yes":"No"):String(value??"Not specified")}</dd></div>)}</dl></section>)}
        </section>
        <section hidden={section!=="assignments"} role="tabpanel" id={`${tabsId}-assignments-panel`} aria-labelledby={`${tabsId}-assignments-tab`} tabIndex={0} aria-label="assignments" className="space-y-4 pt-4">
          <p className="text-sm text-muted-foreground">Assignments are read-only. Group membership, exclusions and filters determine whether a particular PC is included.</p>
          {details.assignmentWarning&&<p role="status" className="rounded-xl bg-secondary p-4 text-sm">{details.assignmentWarning}</p>}
          {details.assignments?.length===0&&<p className="text-sm text-muted-foreground">No assignments returned for this app.</p>}
          {details.assignments?.map((assignment,index)=><div key={index} className="rounded-xl border p-4 text-sm"><p className="font-medium">{assignment.intent.slice(0,1).toUpperCase()+assignment.intent.slice(1)} · {targets[assignment.target]??friendly(assignment.target)}</p>{assignment.groupId&&<p className="mt-2 break-all font-mono text-xs">Group: {assignment.groupId}</p>}{assignment.filterId&&<p className="mt-2 break-all text-xs">Filter: {assignment.filterId} ({assignment.filterType})</p>}</div>)}
        </section>
      </div>}
      {printing&&<p role="status" className="text-sm text-muted-foreground">Preparing app details…</p>}
      {printNotice&&<p role="status" className="rounded-xl bg-secondary p-3 text-sm">{printNotice}</p>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!details||printing} onClick={()=>void print()}><Printer className="mr-2 size-4" aria-hidden="true"/>Print</Button><Button variant="ghost" onClick={()=>{if(app){const link=adminCenterLink("Apps",app.id);if(link)void bridge.app.openExternal(link.url)}}}><ExternalLink className="mr-2 size-4" aria-hidden="true"/>Intune</Button></div>
        <Button disabled={printing} onClick={()=>{if(app)onBackup(app)}}>Backup</Button>
      </div>
    </DialogContent>
  </Dialog>
}
