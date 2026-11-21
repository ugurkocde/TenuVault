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

export const OMISSION_VERSION = rules.version
export const OMISSION_MARKER = "_tenuvaultOmitted"
export const OMISSION_BLOCKER = "Values were left out of this backup. Use a backup that includes them to restore this item."

export function hasOmissions(snapshot: unknown): boolean {
  return !!snapshot && typeof snapshot === "object" && Object.hasOwn(snapshot, OMISSION_MARKER)
}

export function projectSecrets(folder: string, snapshot: Item, scripts: boolean, reasons?: ReadonlySet<OmittedField["reason"]>): { snapshot: Item; fields: OmittedField[] } {
  const fields: OmittedField[] = []
  const escape = (part: string) => part.replaceAll("~", "~0").replaceAll("/", "~1")
  const subtype = String(snapshot["@odata.type"] ?? "")
  const credentials = rules.credentials.filter((rule) => rule.folder === folder && new RegExp(rule.subtype, "i").test(subtype))
  const scriptFields = scripts ? (rules.scripts as Record<string, string[]>)[folder] ?? [] : []
  function visit(value: Json, path: string, oma = false): Json {
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}/${index}`, oma))
    if (!value || typeof value !== "object") return value
    const type = String(value["@odata.type"] ?? "")
    const encrypted = folder === "DeviceConfigurations" && oma && encryptedOmaSetting(value)
    const secret = type.toLowerCase().endsWith(rules.typedSecretSuffix.toLowerCase())
    const copy: Item = {}
    for (const key of Object.keys(value).sort()) {
      if ((key === OMISSION_MARKER && !path) || (encrypted && key === "_tenuvaultOmaMasked")) continue
      const property = value[key]!
      const pointer = `${path}/${escape(key)}`
      let reason: OmittedField["reason"] | undefined
      if (encrypted && (key === "value" || key === "secretReferenceValueId")) reason = "encrypted-oma"
      else if (secret && (key === "value" || key === "valueState")) reason = "typed-secret"
      else if (!path && (property != null || reasons)) {
        if (folder === rules.androidFolder && rules.androidFields.includes(key)) reason = "enrollment-credential"
        else if (credentials.some((rule) => rule.field === key)) reason = "credential"
        else if (scriptFields.includes(key)) reason = "script"
      }
      if (reason && (!reasons || reasons.has(reason))) fields.push({ path: pointer, reason })
      else Object.defineProperty(copy, key, { value: visit(property, pointer, path === "" && key === "omaSettings"), enumerable: true, writable: true, configurable: true })
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
function withoutPartialCollections(older: Item, newer: Item): [Item, Item] {
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
  collect(older, "")
  collect(newer, "")
  if (!partial.size) return [older, newer]
  const strip = (value: Json, path: string): Json => {
    if (Array.isArray(value)) return value.map((entry) => strip(entry, `${path}/[]`))
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => !partial.has(segment(path, key)) && !key.endsWith("@odata.nextLink"))
      .map(([key, entry]) => [key, strip(entry, segment(path, key))]))
  }
  return [strip(older, "") as Item, strip(newer, "") as Item]
}

export function comparisonOmission(...metadata: Array<{ OmissionVersion?: unknown; OmissionScripts?: unknown }>): OmissionOptions | undefined {
  const active = metadata.filter((value) => value.OmissionVersion === OMISSION_VERSION)
  return active.length ? { enabled: true, scripts: active.some((value) => value.OmissionScripts === true) } : undefined
}

export function observablePair(folder: string, older: Item, newer: Item, masked = false, policy?: OmissionOptions): [Item, Item] {
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
  if (!reasons.size) return withoutPartialCollections(older, newer)
  return withoutPartialCollections(
    projectSecrets(folder, older, reasons.has("script"), reasons).snapshot,
    projectSecrets(folder, newer, reasons.has("script"), reasons).snapshot,
  )
}

export function projectRollback(folder: string, snapshot: Item, options: OmissionOptions | undefined): Item {
  if (!options?.enabled) return snapshot
  const projected = projectSecrets(folder, snapshot, options.scripts)
  return projected.fields.length ? omissionBody(projected.snapshot, projected.fields) : snapshot
}
