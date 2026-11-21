import { encryptedOmaSetting } from "./registry"
import rules from "./secret-rules.json"
import type { Item, Json } from "./registry"

export interface OmissionOptions {
  enabled: boolean
  scripts: boolean
}

export interface OmittedField {
  path: string
  reason: "encrypted-oma" | "typed-secret" | "enrollment-credential" | "credential" | "script"
}

export const omissionPolicyPath = (tenant: string) => `.tenuvault-control/${tenant.toLowerCase()}/secret-omission.json`

export const OMISSION_VERSION = rules.version
export const OMISSION_MARKER = "_tenuvaultOmitted"
export const OMISSION_BLOCKER = "Values were left out of this backup. Use a backup that includes them to restore this item."

export function hasOmissions(snapshot: unknown): boolean {
  return !!snapshot && typeof snapshot === "object" && Object.hasOwn(snapshot, OMISSION_MARKER)
}

const escapePointer = (part: string) => part.replaceAll("~", "~0").replaceAll("/", "~1")
const isSettingSecret = (value: Item) => value.valueState === "encryptedValueToken" ||
  String(value["@odata.type"] ?? "").toLowerCase().endsWith(rules.typedSecretSuffix.toLowerCase())

function settingIdentity(value: Item, parent: string, key: string): string {
  return typeof value.settingDefinitionId === "string" ? `definition:${value.settingDefinitionId}` : parent ? `${parent}/${key}` : ""
}

function omittedIdentities(folder: string, older: Item, newer: Item, reasons: ReadonlySet<OmittedField["reason"]>): Set<string> {
  const result = new Set<string>()
  for (const snapshot of [older, newer]) {
    const fields = snapshot[OMISSION_MARKER]
    const markers = new Set(
      fields && typeof fields === "object" && !Array.isArray(fields) && Array.isArray(fields.fields)
        ? fields.fields.flatMap((field) => field && typeof field === "object" && !Array.isArray(field) && field.reason === "typed-secret" ? [field.path] : [])
        : [],
    )
    function collect(value: Json, path: string, parent: string, key: string, oma: boolean): void {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collect(entry, `${path}/${index}`, parent, key, oma))
      } else if (value && typeof value === "object") {
        const identity = settingIdentity(value, parent, key)
        if (folder === "DeviceConfigurations" && oma && reasons.has("encrypted-oma") && encryptedOmaSetting(value) && typeof value.omaUri === "string") result.add(`oma:${value.omaUri}`)
        if (identity && reasons.has("typed-secret") && (isSettingSecret(value) || markers.has(`${path}/value`) || markers.has(`${path}/valueState`))) result.add(identity)
        for (const [property, entry] of Object.entries(value)) collect(entry, `${path}/${escapePointer(property)}`, identity, property, path === "" && property === "omaSettings")
      }
    }
    collect(snapshot, "", "", "", false)
  }
  return result
}

export function projectSecrets(folder: string, snapshot: Item, scripts: boolean, reasons?: ReadonlySet<OmittedField["reason"]>, identities?: ReadonlySet<string>): { snapshot: Item; fields: OmittedField[] } {
  const fields: OmittedField[] = []
  const subtype = String(snapshot["@odata.type"] ?? "")
  const credentials = rules.credentials.filter((rule) => rule.folder === folder && new RegExp(rule.subtype, "i").test(subtype))
  const scriptFields = scripts ? (rules.scripts as Record<string, string[]>)[folder] ?? [] : []
  function visit(value: Json, path: string, oma = false, parent = "", member = ""): Json {
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}/${index}`, oma, parent, member))
    if (!value || typeof value !== "object") return value
    const identity = settingIdentity(value, parent, member)
    const encrypted = folder === "DeviceConfigurations" && oma && (encryptedOmaSetting(value) || identities?.has(`oma:${value.omaUri}`))
    const secret = isSettingSecret(value) || identities?.has(identity)
    const copy: Item = {}
    // A typed and an untyped token represent the same unavailable operand.
    if (secret && reasons?.has("typed-secret")) copy["@odata.type"] = `#microsoft.graph.${rules.typedSecretSuffix}`
    for (const key of Object.keys(value).sort()) {
      if (key === "@odata.type" && secret && reasons?.has("typed-secret")) continue
      if ((key === OMISSION_MARKER && !path) || (encrypted && (key === "_tenuvaultOmaMasked" || (key === "isEncrypted" && reasons?.has("encrypted-oma"))))) continue
      const property = value[key]!
      const pointer = `${path}/${escapePointer(key)}`
      let reason: OmittedField["reason"] | undefined
      if (encrypted && (key === "value" || key === "secretReferenceValueId")) reason = "encrypted-oma"
      else if (secret && (key === "value" || key === "valueState")) reason = "typed-secret"
      else if ((property != null || reasons) && credentials.some((rule) => rule.field === key)) reason = "credential"
      else if (!path && (property != null || reasons)) {
        if (folder === rules.androidFolder && rules.androidFields.includes(key)) reason = "enrollment-credential"
        else if (scriptFields.includes(key)) reason = "script"
      }
      if (reason && (!reasons || reasons.has(reason))) fields.push({ path: pointer, reason })
      else Object.defineProperty(copy, key, { value: visit(property, pointer, path === "" && key === "omaSettings", identity, key), enumerable: true, writable: true, configurable: true })
    }
    return copy
  }
  return { snapshot: visit(snapshot, "") as Item, fields }
}

export function omissionBody(snapshot: Item, fields: OmittedField[]): Item {
  return { ...snapshot, [OMISSION_MARKER]: { version: OMISSION_VERSION, fields: fields.map(({ path, reason }) => ({ path, reason })) } }
}

export function snapshotPath(folder: string, item: { file: string; omitted?: unknown }): string {
  return `${item.omitted === undefined ? "" : ".omitted/"}${folder}/${item.file}`
}

export function omittedFolders(items: unknown): Set<string> {
  const folders = new Set<string>()
  if (!items || typeof items !== "object" || Array.isArray(items)) return folders
  for (const [key, item] of Object.entries(items)) {
    if (item && typeof item === "object" && Object.hasOwn(item, "omitted")) folders.add(key.split("/")[0]!)
  }
  return folders
}

/**
 * Old snapshots can hold part of a nested collection when Graph paged it. An expanded copy
 * cannot establish which values changed in that collection. Array positions are deliberately
 * ignored at this step so a moved setting cannot make a partially read collection look complete.
 */
export function partialCollectionPaths(...items: Item[]): string[] {
  const partial = new Set<string>()
  const segment = (path: string, key: string) => `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`
  const collect = (value: Json, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => collect(entry, `${path}/[]`))
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (key.endsWith("@odata.nextLink") && typeof entry === "string") partial.add(segment(path, key.slice(0, -"@odata.nextLink".length)))
        else collect(entry, segment(path, key))
      }
    }
  }
  for (const item of items) collect(item, "")
  return [...partial].sort()
}

function withoutPartialCollections(older: Item, newer: Item): [Item, Item, string[]] {
  const paths = partialCollectionPaths(older, newer)
  if (!paths.length) return [older, newer, []]
  const partial = new Set(paths)
  const strip = (value: Json, path: string): Json => {
    if (Array.isArray(value)) return value.map((entry) => strip(entry, `${path}/[]`))
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => !partial.has(`${path}/${escapePointer(key)}`) && !key.endsWith("@odata.nextLink"))
      .map(([key, entry]) => [key, strip(entry, `${path}/${escapePointer(key)}`)]))
  }
  return [strip(older, "") as Item, strip(newer, "") as Item, paths]
}

export function comparisonOmission(...metadata: Array<{ OmissionVersion?: unknown; OmissionScripts?: unknown }>): OmissionOptions | undefined {
  const active = metadata.filter((value) => value.OmissionVersion === OMISSION_VERSION)
  return active.length ? { enabled: true, scripts: active.some((value) => value.OmissionScripts === true) } : undefined
}

export function observablePair(folder: string, older: Item, newer: Item, masked = false, policy?: OmissionOptions): [Item, Item, string[]] {
  const reasons = new Set<OmittedField["reason"]>()
  if (policy?.enabled) {
    for (const reason of ["encrypted-oma", "typed-secret", "enrollment-credential", "credential"] as const) reasons.add(reason)
    if (policy.scripts) reasons.add("script")
  }
  if (masked) reasons.add("encrypted-oma")
  for (const item of [older, newer]) {
    const marker = item[OMISSION_MARKER]
    if (!marker || typeof marker !== "object" || Array.isArray(marker) || !Array.isArray(marker.fields)) continue
    for (const field of marker.fields) {
      if (field && typeof field === "object" && !Array.isArray(field)) reasons.add(field.reason as OmittedField["reason"])
    }
  }
  if (!policy?.enabled && !hasOmissions(older) && !hasOmissions(newer)) return [older, newer, []]
  const identities = omittedIdentities(folder, older, newer, reasons)
  return withoutPartialCollections(
    projectSecrets(folder, older, reasons.has("script"), reasons, identities).snapshot,
    projectSecrets(folder, newer, reasons.has("script"), reasons, identities).snapshot,
  )
}

export function projectRollback(folder: string, snapshot: Item, options: OmissionOptions | undefined): Item {
  if (!options?.enabled) return snapshot
  const projected = projectSecrets(folder, snapshot, options.scripts)
  return projected.fields.length ? omissionBody(projected.snapshot, projected.fields) : snapshot
}
