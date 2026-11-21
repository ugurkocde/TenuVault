import { createHash } from "node:crypto"
import type { KeyValueStore } from "../storage/secure-store"
import { RestoreSafetyError } from "../../shared/intune/restore-guards"
import { directoryMappingKey, directoryObjectState } from "./directory-object-state"

/** Bind the whole relationship difference, including unchanged principals, in bounded records. */
export class DirectoryPrincipalMappings {
  private ids: string[] = []
  private parts = 0
  private readonly hash = createHash("sha256")
  constructor(private readonly store: KeyValueStore, private readonly tenant: string, private readonly inventory: string) {}
  private key(part: number) { return `restore.directory.principals.${this.tenant.toLowerCase()}.${this.inventory}.${part}` }
  private state(id: string) {
    return ["Users", "Groups"].map(folder => this.store.get(directoryMappingKey(this.tenant, folder, id)))
  }
  capture(id: string): string {
    directoryObjectState(this.store, this.tenant, "").recoverMappings(["Users", "Groups"].map(folder => ({ folder, sourceId: id })))
    const mappings = this.state(id)
    this.hash.update(JSON.stringify([id, ...mappings]) + "\n")
    this.ids.push(id)
    if (this.ids.length === 1000) this.flush()
    return mappings[0] ?? mappings[1] ?? id
  }
  private flush() {
    if (!this.ids.length) return
    this.store.set(this.key(this.parts), JSON.stringify(this.ids))
    this.parts++; this.ids = []
  }
  finish() {
    this.flush()
    return { parts: this.parts, fingerprint: this.hash.digest("hex") }
  }
  discard() {
    for (let part = 0; part < this.parts; part++) this.store.delete(this.key(part))
  }
  /** Synchronous final validation prevents a mapping publication racing the send marker. */
  validate(expected: { parts: number; fingerprint: string }) {
    const hash = createHash("sha256")
    for (let part = 0; part < expected.parts; part++) {
      const raw = this.store.get(this.key(part))
      if (!raw) throw new RestoreSafetyError("The principal mapping inventory is unavailable. Preview these relationships again.")
      const ids: string[] = JSON.parse(raw)
      directoryObjectState(this.store, this.tenant, "").recoverMappings(ids.flatMap(sourceId => ["Users", "Groups"].map(folder => ({ folder, sourceId }))))
      for (const id of ids) hash.update(JSON.stringify([id, ...this.state(id)]) + "\n")
    }
    if (hash.digest("hex") !== expected.fingerprint) throw new RestoreSafetyError("A principal mapping changed. Preview these relationships again.")
  }
}
