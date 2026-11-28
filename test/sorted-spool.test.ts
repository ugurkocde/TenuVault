import { expect, it } from "vitest"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { SortedSpool } from "../src/main/backup/sorted-spool"

it("merges more than 64 encrypted runs without keeping the inventory in memory", async () => {
  const spool = new SortedSpool<{ id: string; definition: string }>()
  try {
    for (let at = 69; at >= 0; at--) await spool.add([{ id: `id-${String(at).padStart(3, "0")}`, definition: "private-definition" }])
    const root = await (spool as unknown as { root: Promise<string> }).root
    for (const name of await readdir(root)) expect((await readFile(join(root, name))).includes(Buffer.from("private-definition"))).toBe(false)
    let count = 0, previous = ""
    for await (const entry of spool.entries()) { expect(entry.id > previous).toBe(true); previous = entry.id; count++ }
    expect(count).toBe(70)
  } finally { await spool.close() }
})
it("rejects tampered encrypted runs and duplicate identities", async () => {
  const spool = new SortedSpool<{ id: string }>()
  try {
    await spool.add([{ id: "one" }])
    const root = await (spool as unknown as { root: Promise<string> }).root
    const file = join(root, (await readdir(root))[0]!), raw = await readFile(file)
    raw[12] = raw[12]! ^ 1
    await writeFile(file, raw)
    await expect((async () => { for await (const _entry of spool.entries()) {} })()).rejects.toThrow()
  } finally { await spool.close() }
  const duplicate = new SortedSpool<{ id: string }>()
  try {
    await duplicate.add([{ id: "one" }, { id: "ONE" }])
    await expect((async () => { for await (const _entry of duplicate.entries()) {} })()).rejects.toThrow("repeated")
  } finally { await duplicate.close() }
})
it("bounds object count and interrupts sort work with the type signal", async () => {
  const controller = new AbortController(), spool = new SortedSpool<{ id: string }>(1, controller.signal)
  try {
    await spool.add([{ id: "one" }])
    await expect(spool.add([{ id: "two" }])).rejects.toThrow("limit")
    controller.abort(new Error("type stopped"))
    await expect((async () => { for await (const _entry of spool.entries()) {} })()).rejects.toThrow("type stopped")
  } finally { await spool.close() }
})
