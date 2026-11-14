import { describe, expect, it } from "vitest"
import { INTUNE_TYPES, type IntuneType } from "../src/shared/intune/registry"
import { testType } from "./helpers/backup-fixture"

/**
 * What a type declares must be something the reader (shared/intune/read) and the engine can do.
 * The reader stores a list-only type from its list entry without another read, reduces an object
 * to the properties it keeps once, and removes never-stored properties last. A declaration that
 * asks for something else would be dropped without a word: a sub-read that is never made, a value
 * that is declared as kept and is not stored. The registry may not hold such a type.
 */
function contradictions(type: IntuneType): string[] {
  const found: string[] = []
  if (type.listOnly) {
    // Stored as listed: no detail GET, so nothing a detail GET or a sub-read would add.
    if (type.extras?.length) found.push("listOnly with extras: the sub-reads are never made")
    if (type.secrets) found.push("listOnly with secrets: the plain values are never read")
    if (type.expand || type.select) found.push("listOnly with expand or select: there is no detail GET to shape")
    if (type.singleton) found.push("listOnly with singleton: a tenant-wide object has no list")
  }
  if (type.keep && type.singleton?.properties) found.push("keep with singleton.properties: two lists of what to keep")
  for (const path of type.neverStored ?? []) {
    if (path === "id") found.push("neverStored names id, which is always stored")
    if (type.keep?.includes(path)) found.push(`keep and neverStored both name ${path}`)
    if (type.singleton?.properties?.includes(path)) found.push(`singleton.properties and neverStored both name ${path}`)
    if (type.extras?.some((extra) => extra.property === path)) found.push(`neverStored names ${path}, which a sub-read stores`)
  }
  if (type.filter && /(^|&)\$filter=/i.test(type.listQuery ?? "")) found.push("filter with a $filter in listQuery: two filters on one list")
  for (const extra of type.extras ?? []) {
    if ([extra.single, extra.ids, extra.each].filter(Boolean).length > 1) found.push(`extra ${extra.property} declares more than one of single, ids and each`)
  }
  return found
}

/**
 * The answers a type declares as "not configured" that cannot mean it: only a refusal of the
 * request itself (4xx) can say that a setting was never made. A throttle (429) or a server error
 * says nothing about the tenant, and counting it as "not configured" would hide a type that was not read.
 */
function unsoundAnswers(type: IntuneType): number[] {
  return (type.notConfigured ?? []).map((answer) => answer.status).filter((status) => !Number.isInteger(status) || status < 400 || status > 499 || status === 429)
}

describe("what the registry's types declare", () => {
  it("never contradicts itself in a way the reader cannot honour", () => {
    expect(INTUNE_TYPES.map((type) => ({ folder: type.folder, found: contradictions(type) })).filter((type) => type.found.length)).toEqual([])
  })

  it("names an answer as not configured only when it is a refused request, never a throttle or a server error", () => {
    expect(INTUNE_TYPES.map((type) => ({ folder: type.folder, found: unsoundAnswers(type) })).filter((type) => type.found.length)).toEqual([])
  })
})

describe("the check of a type's declarations", () => {
  const members = { property: "members", path: (id: string) => `things/${id}/members` }

  it.each<[string, Partial<IntuneType>, string]>([
    ["a list-only type with sub-reads", { listOnly: true, extras: [members] }, "listOnly with extras: the sub-reads are never made"],
    ["a list-only type with masked values", { listOnly: true, secrets: () => [] }, "listOnly with secrets: the plain values are never read"],
    ["a list-only type with an expand", { listOnly: true, expand: "assignments" }, "listOnly with expand or select: there is no detail GET to shape"],
    ["a list-only type with a select", { listOnly: true, select: "id" }, "listOnly with expand or select: there is no detail GET to shape"],
    ["a list-only tenant-wide object", { listOnly: true, singleton: { id: "thing", name: "Thing" } }, "listOnly with singleton: a tenant-wide object has no list"],
    ["two lists of kept properties", { keep: ["a"], singleton: { id: "thing", name: "Thing", properties: ["b"] } }, "keep with singleton.properties: two lists of what to keep"],
    ["a kept property that is never stored", { keep: ["credentials"], neverStored: ["credentials"] }, "keep and neverStored both name credentials"],
    ["a tenant-wide object's kept property that is never stored", { singleton: { id: "thing", name: "Thing", properties: ["secret"] }, neverStored: ["secret"] }, "singleton.properties and neverStored both name secret"],
    ["a sub-read whose result is never stored", { extras: [members], neverStored: ["members"] }, "neverStored names members, which a sub-read stores"],
    ["an ID that is never stored", { neverStored: ["id"] }, "neverStored names id, which is always stored"],
    ["two filters", { filter: "source eq 'tenant'", listQuery: "$top=5&$filter=enabled eq true" }, "filter with a $filter in listQuery: two filters on one list"],
    ["a sub-read stored in two ways", { extras: [{ ...members, ids: true, single: true }] }, "extra members declares more than one of single, ids and each"],
  ])("refuses %s", (_what, declared, expected) => {
    expect(contradictions(testType("Things", "things", declared))).toEqual([expected])
  })

  it("accepts what the reader honours together", () => {
    // Kept properties of the object itself, a part of one never stored, and sub-reads next to them.
    expect(contradictions(testType("Things", "things", { keep: ["displayName", "settings"], neverStored: ["settings.secret", "members.seenAt"], extras: [members], filter: "source eq 'tenant'", listQuery: "$top=5" }))).toEqual([])
    expect(contradictions(testType("Things", "things", { listOnly: true, keep: ["displayName"], neverStored: ["lastSeen"] }))).toEqual([])
    expect(contradictions(testType("Things", "things", { singleton: { id: "thing", name: "Thing", collection: true }, extras: [{ ...members, ids: true }], neverStored: ["modified"] }))).toEqual([])
  })

  it.each([429, 500, 503, 200, 302, 404.5])("refuses %s as an answer that means not configured", (status) => {
    expect(unsoundAnswers(testType("Things", "things", { notConfigured: [{ status: 404 }, { status }] }))).toEqual([status])
  })

  it("accepts refused requests as answers that mean not configured", () => {
    expect(unsoundAnswers(testType("Things", "things", { notConfigured: [{ status: 400 }, { status: 403, message: "not onboarded" }, { status: 404, code: "Request_ResourceNotFound" }] }))).toEqual([])
  })
})
