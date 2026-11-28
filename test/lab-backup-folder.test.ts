import { mkdtemp, readdir, rm, symlink, writeFile, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { copyLabBackups, guardLabBackupWrites, isStableBackupFolder, LAB_FOLDER_ERROR } from "../src/main/backup/lab-folder"
import { LocalBlobStore } from "../src/main/storage/local-blob-store"
import { BACKUP_CONTAINER, localStorageAccountName } from "../src/shared/constants"
import { backupBlobName, LARGE_BACKUP_CONTAINER } from "../src/shared/backup-storage"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const account = localStorageAccountName("11111111-1111-1111-1111-111111111111")
const keys = [Buffer.alloc(32, 5)]
const ordinary = "backup-2026-11-01-020000"
const large = "backup-large-2026-11-01-020000"
const content = Buffer.from('{"Status":"Success","Items":{}}')

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tv-lab-folder-"))
  roots.push(root)
  const stable = join(root, "TenuVault Backups")
  const lab = join(root, "TenuVault Lab Backups")
  const alias = join(root, "saved-override")
  const store = new LocalBlobStore(stable, keys)
  await store.createContainer(account, BACKUP_CONTAINER)
  await store.put(account, BACKUP_CONTAINER, `${ordinary}/metadata.json`, content, "application/json")
  await symlink(stable, alias, "junction")
  return { root, stable, lab, alias, store, guard: guardLabBackupWrites(stable) }
}

it("allows old Lab backups to be read through an alias and blocks mutations through the saved override", async () => {
  const { alias, stable, lab, guard, store } = await setup()
  const browse = new LocalBlobStore(alias, keys, undefined, guard)
  const name = `${ordinary}/metadata.json`
  expect((await browse.get(account, BACKUP_CONTAINER, name)).data).toEqual(content)
  await expect(browse.createContainer(account, LARGE_BACKUP_CONTAINER)).rejects.toThrow(LAB_FOLDER_ERROR)
  await expect(browse.put(account, BACKUP_CONTAINER, name, Buffer.from("{}"), "application/json")).rejects.toThrow(LAB_FOLDER_ERROR)
  await expect(browse.delete(account, BACKUP_CONTAINER, name)).rejects.toThrow(LAB_FOLDER_ERROR)
  expect((await store.get(account, BACKUP_CONTAINER, name)).data).toEqual(content)
  expect(isStableBackupFolder(join(alias, "..", "TENuVAULT BACKUPS"), stable)).toBe(true)
  expect(isStableBackupFolder(join(alias, "new"), stable)).toBe(true)
  expect(() => guard(lab)).not.toThrow()
})

it("checks existing child aliases and rechecks redirected folders before a write", async () => {
  const { root, alias, stable, lab, guard } = await setup()
  await mkdir(lab)
  await symlink(join(stable, account), join(lab, account), "junction")
  const guarded = new LocalBlobStore(lab, keys, undefined, guard)
  await expect(guarded.createContainer(account, BACKUP_CONTAINER)).rejects.toThrow(LAB_FOLDER_ERROR)
  const deferred = join(root, "deferred")
  const store = new LocalBlobStore(deferred, keys, undefined, guard)
  await symlink(alias, deferred, "junction")
  await expect(store.createContainer(account, BACKUP_CONTAINER)).rejects.toThrow(LAB_FOLDER_ERROR)
})

it("copies and verifies readable Lab backups from both containers and keeps every original", async () => {
  const { stable, lab, alias, guard, store } = await setup()
  await store.createContainer(account, LARGE_BACKUP_CONTAINER)
  const payload = backupBlobName(`${large}/Users/one.json`)
  await store.put(account, LARGE_BACKUP_CONTAINER, payload, Buffer.from('{"id":"one"}'), "application/json")
  await store.put(account, LARGE_BACKUP_CONTAINER, `${large}/metadata.json`, content, "application/json")
  const foreign = "backup-2026-11-02-020000/metadata.json"
  await new LocalBlobStore(stable, [Buffer.alloc(32, 6)]).put(account, BACKUP_CONTAINER, foreign, content, "application/json")

  const files = async (root: string) => {
    const paths = await readdir(root, { recursive: true, withFileTypes: true })
    return Promise.all(paths.filter(file => file.isFile()).map(file => readFile(join(file.parentPath, file.name))))
  }
  const original = await files(stable)
  expect(await copyLabBackups(alias, lab, keys, guard)).toMatchObject({ copied: 2, skipped: expect.any(Number) })
  expect(await files(stable)).toEqual(original)
  const copy = new LocalBlobStore(lab, keys)
  expect((await copy.get(account, BACKUP_CONTAINER, `${ordinary}/metadata.json`)).data).toEqual(content)
  expect((await copy.get(account, LARGE_BACKUP_CONTAINER, payload)).data.toString()).toBe('{"id":"one"}')
  expect(await copy.list(account, BACKUP_CONTAINER)).toHaveLength(1)

  await copy.put(account, LARGE_BACKUP_CONTAINER, payload, Buffer.from('{"id":"conflict"}'), "application/json")
  expect((await copyLabBackups(alias, lab, keys, guard)).copied).toBe(1)
  expect((await copy.get(account, LARGE_BACKUP_CONTAINER, payload)).data.toString()).toBe('{"id":"conflict"}')
  expect(await files(stable)).toEqual(original)
})

it("does not copy a manifest when a source policy cannot be authenticated", async () => {
  const { stable, lab, guard, store } = await setup()
  const dir = join(stable, account, BACKUP_CONTAINER)
  const before = await readdir(dir)
  await store.put(account, BACKUP_CONTAINER, `${ordinary}/DeviceConfigurations/a.json`, Buffer.from('{"id":"a"}'), "application/json")
  const path = join(dir, (await readdir(dir)).find(name => !before.includes(name))!)
  const raw = await readFile(path)
  raw[raw.length - 1]! ^= 1
  await writeFile(path, raw)
  expect(await copyLabBackups(stable, lab, keys, guard)).toEqual({ copied: 0, skipped: 1 })
  expect(await new LocalBlobStore(lab, keys).list(account, BACKUP_CONTAINER)).toEqual([])
  expect(await readFile(path)).toEqual(raw)
})
