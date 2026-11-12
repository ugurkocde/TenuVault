import { createHash } from "node:crypto"
import type { IntuneAppAssignment, IntuneAppDetails, IntuneAppScript } from "../../shared/app-sources/types"
import { sourceTenant } from "../app-sources/store"
import { appMetadataGet, appText, appIcon, appDate } from "./graph-read"

const TYPE = "#microsoft.graph.win32LobApp"
const qualified = ["displayVersion", "fileName", "size", "installCommandLine", "uninstallCommandLine", "installExperience", "activeInstallScript", "activeUninstallScript", "committedContentVersion", "rules"].map(field => `microsoft.graph.win32LobApp/${field}`)
const SELECT = ["id", "displayName", "publisher", "description", "largeIcon", "createdDateTime", "lastModifiedDateTime", ...qualified].join(",")
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function script(value: unknown, kind: IntuneAppScript["kind"]): IntuneAppScript {
  const row = object(value), encoded = row.content ?? row.scriptContent
  const bytes = typeof encoded === "string" && encoded.length <= 140000 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ? Buffer.from(encoded, "base64") : null
  const content = bytes && bytes.length <= 102400 ? bytes.toString("utf8") : null
  const name = appText(row.displayName, 300) || `${kind} script`
  const id = createHash("sha256").update(JSON.stringify([kind,name,content])).digest("hex")
  return { id, name, kind, content, signatureCheck: typeof row.enforceSignatureCheck === "boolean" ? row.enforceSignatureCheck : null, runAs32Bit: typeof row.runAs32Bit === "boolean" ? row.runAs32Bit : null }
}
async function collection(url: string, token: string, fetchImpl: typeof fetch): Promise<unknown[]> {
  const result: unknown[] = [], seen = new Set<string>(), root = new URL(url).pathname
  while (url) {
    const path = new URL(url)
    if (path.pathname !== root || seen.has(url) || seen.size >= 20) throw new Error("Intune returned an invalid detail continuation.")
    seen.add(url)
    const body = await appMetadataGet(url, token, fetchImpl)
    if (!Array.isArray(body.value)) throw new Error("Intune returned an invalid detail list.")
    result.push(...body.value)
    if (result.length > 2000) throw new Error("Intune detail list exceeded its limit.")
    if (body["@odata.nextLink"] !== undefined && typeof body["@odata.nextLink"] !== "string") throw new Error("Intune returned an invalid detail continuation.")
    url = body["@odata.nextLink"] as string ?? ""
  }
  return result
}

export async function readAppBackupDetails(tenant: string, appId: string, tokenForTenant: (tenant: string) => Promise<string>, fetchImpl: typeof fetch): Promise<IntuneAppDetails> {
  const id = sourceTenant(appId), token = await tokenForTenant(sourceTenant(tenant))
  if (!token) throw new Error("Reconnect this tenant's Microsoft session to read app details.")
  const base = `https://graph.microsoft.com/beta/deviceAppManagement/mobileApps/${id}`
  const row = await appMetadataGet(`${base}?$select=${SELECT}`, token, fetchImpl)
  if (row["@odata.type"] !== TYPE || sourceTenant(row.id) !== id || typeof row.displayName !== "string") throw new Error("This is not a Win32 app in the selected tenant.")
  const experience = object(row.installExperience), scripts: IntuneAppScript[] = []
  const rules: IntuneAppDetails["rules"] = []
  for (const raw of Array.isArray(row.rules) ? row.rules.slice(0,100) : []) {
    const rule = object(raw), type = appText(rule["@odata.type"], 150).replace("#microsoft.graph.win32LobApp", ""), purpose = appText(rule.ruleType, 40)
    if (type.includes("PowerShellScript") && scripts.length < 8) scripts.push(script(rule, purpose === "requirement" ? "requirement" : "detection"))
    const properties: Record<string, string | number | boolean | null> = Object.create(null)
    for (const [name, value] of Object.entries(rule).slice(0,30)) {
      if (["@odata.type", "scriptContent", "content"].includes(name)) continue
      if (typeof value === "string") properties[name] = value.slice(0,4096)
      else if (typeof value === "boolean" || typeof value === "number" || value === null) properties[name] = value
    }
    rules.push({ type, purpose, properties })
  }
  let scriptWarning: string | null = null, assignments: IntuneAppAssignment[] | null = null, assignmentWarning: string | null = null
  await Promise.all([
    (async () => {
      const references = [[row.activeInstallScript,"install"], [row.activeUninstallScript,"uninstall"]] as const
      if (!references.some(([ref]) => typeof object(ref).targetId === "string")) return
      try {
        const version = appText(row.committedContentVersion, 100)
        if (!/^[0-9]+$/.test(version)) throw new Error("The app has no readable committed script version.")
        const rows = await collection(`${base}/microsoft.graph.win32LobApp/contentVersions/${version}/scripts`, token, fetchImpl)
        for (const [ref, kind] of references) {
          const target = object(ref).targetId
          if (typeof target !== "string") continue
          const found = rows.find(raw => object(raw).id === target)
          if (!found) { scripts.push({ id: "", name: `${kind} script`, kind, content: null, signatureCheck: null, runAs32Bit: null }); scriptWarning = "An active script was not returned by Intune." }
          else scripts.push(script(found, kind))
        }
      } catch (error) { scriptWarning = error instanceof Error ? error.message : "Install scripts could not be read." }
    })(),
    (async () => {
      try {
        assignments = (await collection(`${base}/assignments`, token, fetchImpl)).map(raw => {
          const item = object(raw), target = object(item.target)
          return { intent: appText(item.intent, 100), target: appText(target["@odata.type"], 150).replace("#microsoft.graph.", ""), groupId: appText(target.groupId, 100) || null, filterId: appText(target.deviceAndAppManagementAssignmentFilterId, 100) || null, filterType: appText(target.deviceAndAppManagementAssignmentFilterType, 100) || null }
        })
      } catch (error) { assignmentWarning = error instanceof Error ? error.message : "Assignments could not be read." }
    })()
  ])
  return {
    id, name: appText(row.displayName,300), publisher: appText(row.publisher,300), version: appText(row.displayVersion,200) || null, icon: appIcon(row.largeIcon), modifiedAt: appDate(row.lastModifiedDateTime), installContext: appText(experience.runAsAccount,40) || null,
    description: appText(row.description,32768), createdAt: appDate(row.createdDateTime), fileName: appText(row.fileName,300) || null, packageBytes: typeof row.size === "number" && Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : null,
    installCommand: appText(row.installCommandLine) || null, uninstallCommand: appText(row.uninstallCommandLine) || null, restartBehavior: appText(experience.deviceRestartBehavior,100) || null, maxRunTimeMinutes: typeof experience.maxRunTimeInMinutes === "number" ? experience.maxRunTimeInMinutes : null,
    scripts, scriptWarning, assignments, assignmentWarning, rules
  }
}
