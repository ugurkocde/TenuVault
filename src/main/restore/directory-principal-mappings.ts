import { restoreTenantKey } from "./restore-tenant-key"
import { createHash } from "node:crypto"
import type { KeyValueStore } from "../storage/secure-store"
import { RestoreSafetyError, RestoreWriteDeferredError } from "../../shared/intune/restore-guards"
import { restorePersistence, type GuardedStep } from "./guarded-run"
import { directoryMappingKey, directoryObjectState } from "./directory-object-state"

type Principal = [id: string, user: string | null, group: string | null, savedMember: boolean]
/** Bind relationship principals in bounded records, including unchanged saved members. */
export class DirectoryPrincipalMappings {
  private records: Principal[] = []
  private parts = 0
  private readonly hash = createHash("sha256")
  private captureMappings?: ReturnType<ReturnType<typeof directoryObjectState>["mappingCapture"]>
  private inventory?: Principal[]
  private readonly byPrincipal = new Map<string, Principal[]>()
  private savedMembers: Principal[] = []
  private readonly store: KeyValueStore
  constructor(store: KeyValueStore, private readonly tenant: string, private readonly inventoryId: string) {
    this.store = { get: key => restorePersistence(() => store.get(key)), set: (key, value) => restorePersistence(() => store.set(key, value)), delete: key => restorePersistence(() => store.delete(key)) }
  }
  private key(part: number) { return `restore.directory.principals.${restoreTenantKey(this.tenant)}.${this.inventoryId}.${part}` }
  private state(id: string): [string | null, string | null] {
    return [this.store.get(directoryMappingKey(this.tenant, "Users", id)), this.store.get(directoryMappingKey(this.tenant, "Groups", id))]
  }
  capture(id: string, savedMember = false): string {
    // Load one coordinator snapshot and cache only the requested principals' journals.
    this.captureMappings ??= directoryObjectState(this.store, this.tenant, "").mappingCapture()
    this.captureMappings(["Users", "Groups"].map(folder => ({ folder, sourceId: id })))
    const mappings = this.state(id)
    const record: Principal = [id, ...mappings, savedMember]
    this.hash.update(JSON.stringify(record) + "\n")
    this.records.push(record)
    if (this.records.length === 1000) this.flush()
    return mappings[0] ?? mappings[1] ?? id
  }
  private flush() {
    if (!this.records.length) return
    const part = this.parts++
    this.store.set(this.key(part), JSON.stringify(this.records))
    this.records = []
  }
  finish() { this.flush(); return { parts: this.parts, fingerprint: this.hash.digest("hex") } }
  discard() {
    let failure: unknown
    for (let part = 0; part < this.parts; part++) {
      try { this.store.delete(this.key(part)) } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }
  /** Load and authenticate once per page; synchronous row validation still follows final safety reads. */
  validate(expected: { parts: number; fingerprint: string }, step: GuardedStep) {
    if (!this.inventory) {
      const hash = createHash("sha256"), records: Principal[] = []
      for (let part = 0; part < expected.parts; part++) {
        const raw = this.store.get(this.key(part))
        if (!raw) throw new RestoreSafetyError("The principal mapping inventory is unavailable. Preview these relationships again.")
        const chunk: Principal[] = JSON.parse(raw)
        if (chunk.some(record => !Array.isArray(record) || record.length !== 4)) throw new RestoreSafetyError("Preview these relationships again to verify their principal mappings.")
        for (const record of chunk) { hash.update(JSON.stringify(record) + "\n"); records.push(record) }
      }
      if (hash.digest("hex") !== expected.fingerprint) throw new RestoreSafetyError("The principal mapping inventory changed. Preview these relationships again.")
      this.inventory = records
      this.savedMembers = records.filter(record => record[3])
      for (const record of records) for (const id of new Set(record.slice(0, 3))) if (typeof id === "string") {
        const key = id.toLowerCase(), involved = this.byPrincipal.get(key) ?? []
        involved.push(record); this.byPrincipal.set(key, involved)
      }
    }
    const removal = step.directory?.exact && step.desired.present === false
    // Every saved member can become the target of an exact removal after recreation.
    const involved = [...new Set([...(removal ? this.savedMembers : []), ...(this.byPrincipal.get(step.directory?.principalId?.toLowerCase() ?? "") ?? [])])]
    const uncertain = directoryObjectState(this.store, this.tenant, "").recoverMappings(involved.flatMap(([sourceId]) => ["Users", "Groups"].map(folder => ({ folder, sourceId }))))
    const unconfirmed = involved.find(([id, , , saved]) => removal && saved && uncertain.has(id.toLowerCase()))
    if (unconfirmed) throw new RestoreWriteDeferredError(`The create for saved member ${unconfirmed[0]} is unconfirmed. Confirm that create, then preview this group's relationships again before exact removal.`)
    for (const [id, user, group] of involved) {
      const current = this.state(id)
      if (current[0] !== user || current[1] !== group) throw new RestoreSafetyError("A principal mapping changed. Preview these relationships again.")
    }
  }
}
