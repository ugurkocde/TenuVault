/**
 * What the observations of a tenant's connections add up to: the state of the admin's sign-in, of
 * the Backup Reader and of the storage sign-in, what each service and area may do and whether the
 * last backup proved it, and what changed since the snapshot.
 *
 * A pure function of the observations, the snapshot kept with them and the time, so the main
 * process, the Settings card and tests reach the same conclusion. It never reads an error message:
 * a failure is its class and its code, looked up in the error table.
 *
 * It states only what an observation shows. A token shows consent, not the admin's role, a license
 * or whether a product was set up: those show when a backup reads a type, or is refused.
 */

import { carryChanges, folderValue } from "./observe"
import { INTUNE_TYPES } from "../intune/registry"
import { areaPermissions, missingForChoice } from "../services/manifest"
import { canBackUp, checkModules, MODULES, moduleForFolder, type AccessLevel, type AreaCheck, type GrantedPermissions, type ModuleId, type PermissionArea, type ServiceModule } from "../services/modules"
import { signInErrorLink, signInErrorRow } from "../sign-in-errors"
import {
  CERTIFICATE_EXPIRING_DAYS,
  RUN_MAX_AGE_MS,
  TOKEN_MAX_AGE_MS,
  type AreaHealth,
  type ConnectionHealthReport,
  type ConnectionMode,
  type ConnectionRecord,
  type FolderRefusal,
  type HealthCause,
  type HealthChange,
  type LossCause,
  type LossEpisode,
  type PermissionChange,
  type PermissionState,
  type ReaderHealth,
  type ReaderHealthState,
  type ReaderObservation,
  type RefusalCause,
  type RunObservation,
  type ServiceHealth,
  type SignInFailure,
  type SignInHealth,
  type SignInHealthState,
  type Snapshot,
  type TokenObservation,
  type VerifiedHealth,
} from "./model"

/** A tenant's choice for one service: on or off, what setup asks for, and its opt-in areas. */
export interface ServiceChoice {
  enabled: boolean
  access: AccessLevel
  areas: Record<string, boolean>
}

export interface HealthInput {
  tenantId: string
  /** The app registration the tenant is connected with. */
  clientId: string
  /** The application ID of the tenant's Backup Reader, once it has one. */
  readerClientId?: string
  /** What this device knows about the Backup Reader now; null when the tenant has none. */
  reader: ReaderObservation | null
  /** Where the tenant's backups go: this device, or an Azure storage account the admin signs in to. */
  storage: "local" | "azure"
  settings: Record<ModuleId, ServiceChoice>
  /** Every connection record kept for the tenant. */
  connections: readonly ConnectionRecord[]
}

export interface HealthEvaluation {
  report: ConnectionHealthReport
  /**
   * The snapshot to keep for the connection in use: the earlier one, with what was learned for the
   * first time since, or a first one. Undefined while nothing was observed for the connection.
   */
  baseline?: Snapshot
  /** The state as it is now. It becomes the snapshot once the changes were looked at. */
  current?: Snapshot
}

/** An observation dated this far ahead of the clock comes from a clock that was set back since. */
const CLOCK_AHEAD_MS = 5 * 60_000

/** Whether something observed at `at` still counts at `now`: not older than `maxAge`, and not dated ahead of the clock. */
function recent(at: string | undefined, maxAge: number, now: Date): boolean {
  const time = at ? Date.parse(at) : Number.NaN
  return Number.isFinite(time) && now.getTime() - time <= maxAge && time - now.getTime() <= CLOCK_AHEAD_MS
}

const sameId = (a: string, b: string | undefined) => !!b && a.toLowerCase() === b.toLowerCase()

/** Services with at least one type this version backs up. */
const WITH_TYPES = new Set(INTUNE_TYPES.map((type) => moduleForFolder(type.folder)?.module.id))

/** The state a failed sign-in of an admin leads to: the row of its code, or what its class alone says. */
export function signInState(failure: SignInFailure): SignInHealthState {
  const row = signInErrorRow(failure.code)
  // A refusal of a certificate is never an answer to an admin's sign-in.
  if (row) return row.state === "refused" ? "unknown" : row.state
  switch (failure.class) {
    case "session": return "signInNeeded"
    case "mfa": return "mfaRequired"
    case "conditionalAccess": return "blockedByConditionalAccess"
    case "consent": return "consentMissing"
    case "assignment": return "notAssigned"
    case "account": return "accountDisabled"
    case "tenant": return "wrongTenantOrAccount"
    case "throttled": return "throttled"
    case "unavailable":
    case "unreachable": return "unreachable"
    default: return "unknown"
  }
}

const named = (failure: SignInFailure) => ({ class: failure.class, ...(failure.code ? { code: failure.code, link: signInErrorLink(failure.code) } : {}) })

function signInHealth(observation: TokenObservation | undefined, now: Date): SignInHealth {
  if (!observation || !recent(observation.at, TOKEN_MAX_AGE_MS, now)) return { state: "notChecked", checkedAt: null }
  if (!observation.failure) return { state: "healthy", checkedAt: observation.at }
  return { state: signInState(observation.failure), checkedAt: observation.at, ...named(observation.failure) }
}

/** The state a refused token request of the Backup Reader leads to. Never an expired certificate: that shows by the certificate's own date. */
function readerFailureState(failure: SignInFailure): ReaderHealthState {
  const failed = signInErrorRow(failure.code)?.class ?? failure.class
  if (failed === "throttled") return "throttled"
  if (failed === "unavailable" || failed === "unreachable") return "unreachable"
  return "refused"
}

/** A successful verification and a health check are both fresh answers about this credential. */
function readerEvidence(facts: ReaderObservation | null, token: TokenObservation | undefined, now: Date): TokenObservation | undefined {
  const answered = token && recent(token.at, TOKEN_MAX_AGE_MS, now) ? token : undefined
  if (facts?.state === "verified" && recent(facts.verifiedAt ?? undefined, TOKEN_MAX_AGE_MS, now) && (!answered || Date.parse(facts.verifiedAt!) > Date.parse(answered.at))) {
    return { at: facts.verifiedAt!, ...(facts.verifiedRoles ? { permissions: facts.verifiedRoles } : {}) }
  }
  return answered
}

function readerHealth(facts: ReaderObservation | null, connection: ConnectionRecord | undefined, now: Date): ReaderHealth {
  if (!facts) return { state: "notSetUp", checkedAt: null }
  const answered = connection?.graph && recent(connection.graph.at, TOKEN_MAX_AGE_MS, now) ? connection.graph : undefined
  const token = readerEvidence(facts, answered, now)
  const expires = Date.parse(facts.notAfter)
  const daysLeft = Math.ceil((expires - now.getTime()) / 86_400_000)
  const known = { checkedAt: token?.at ?? null, notAfter: facts.notAfter, daysLeft, ...(facts.roleChange ? { roleChange: facts.roleChange } : {}) }
  if (facts.state === "pending") return { state: "pending", ...known }
  // The certificate's own date: an expired one is never sent to Microsoft, so no answer could say so.
  if (!(expires > now.getTime())) return { state: "certificateExpired", ...known }
  if (token?.failure) return { state: readerFailureState(token.failure), ...known, ...named(token.failure) }
  if (facts.roleChange) return { state: "rolesChanged", ...known }
  if (daysLeft <= CERTIFICATE_EXPIRING_DAYS) return { state: "certificateExpiring", ...known }
  return { state: "healthy", ...known }
}

/**
 * The runs of a connection that still count, newest first: recent ones, each once, and for an
 * admin's connection only the runs of the account its observations are for.
 */
function runsOf(record: ConnectionRecord | undefined, now: Date): RunObservation[] {
  if (!record) return []
  const runs = new Map<string, RunObservation>()
  for (const run of record.runs) {
    if (!runs.has(run.runId) && recent(run.at, RUN_MAX_AGE_MS, now) && (record.mode === "app-only" || run.account === record.account)) runs.set(run.runId, run)
  }
  return [...runs.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

interface Entry {
  time: number
  at: string
  mode: ConnectionMode
  permissionHeld?: boolean
  kind: "read" | "refused" | "unread" | "excluded"
  cause?: "permission" | "role" | "license" | "reader" | "signedIn"
}

/**
 * What is known about each folder, newest first: what every run that counts says, and what each
 * connection keeps per folder, which is still known when the runs behind it are no longer kept.
 */
function evidenceOf(records: ReadonlyArray<ConnectionRecord | undefined>, now: Date): Map<string, Entry[]> {
  const byFolder = new Map<string, Entry[]>()
  const add = (folder: string, entry: Entry) => {
    const entries = byFolder.get(folder)
    if (entries) entries.push(entry)
    else byFolder.set(folder, [entry])
  }
  for (const record of records) {
    if (!record) continue
    for (const run of runsOf(record, now)) {
      const base = { time: Date.parse(run.at), at: run.at, mode: record.mode }
      for (const folder of run.read) add(folder, { ...base, kind: "read" })
      for (const refusal of run.refused) add(refusal.folder, { ...base, kind: "refused", cause: refusal.cause, permissionHeld: refusal.permissionHeld })
      for (const folder of run.unread) add(folder, { ...base, kind: "unread" })
      for (const left of run.excluded) add(left.folder, { ...base, kind: "excluded", cause: left.cause })
    }
    for (const [folder, at] of Object.entries(record.verified)) {
      if (recent(at, RUN_MAX_AGE_MS, now)) add(folder, { time: Date.parse(at), at, mode: record.mode, kind: "read" })
    }
    for (const [folder, refusals] of Object.entries(record.refused)) {
      for (const refusal of refusals) if (recent(refusal.at, RUN_MAX_AGE_MS, now)) add(folder, { time: Date.parse(refusal.at), at: refusal.at, mode: record.mode, kind: "refused", cause: refusal.cause, permissionHeld: refusal.permissionHeld })
    }
  }
  for (const entries of byFolder.values()) entries.sort((a, b) => b.time - a.time)
  return byFolder
}

type Verdict = { folder: string; at: string; time: number; mode: ConnectionMode } & ({ read: true } | { read: false; cause: HealthCause; mode: ConnectionMode })

/** Only a permission the run is known to have lacked can be described as a cause that is gone. */
function causeNow(folder: string, cause: RefusalCause, granted: GrantedPermissions | undefined, permissionHeld?: boolean): LossCause {
  if (cause !== "permission" || !granted || !canBackUp(folder, granted)) return cause
  return permissionHeld === false ? "notVerifiedYet" : "refusedWithPermission"
}

/**
 * Whether the last backup that said something about a folder read it. A backup that left the
 * folder out by design says nothing, so an earlier read still stands; when no backup ever said
 * anything, the reason it was left out is the cause, which is never a refusal: nothing was asked.
 */
function verdictOf(folder: string, entries: readonly Entry[] | undefined, current: Partial<Record<ConnectionMode, GrantedPermissions>>): Verdict | undefined {
  if (!entries?.length) return undefined
  const said = entries.find((entry) => entry.kind !== "excluded")
  if (!said) {
    const left = entries[0]!
    return { folder, at: left.at, time: left.time, read: false, cause: left.cause === "signedIn" ? "signedIn" : "reader", mode: left.mode }
  }
  const base = { folder, at: said.at, time: said.time, mode: said.mode }
  if (said.kind === "read") return { ...base, read: true }
  if (said.kind === "unread") return { ...base, read: false, cause: "notRead", mode: said.mode }
  return { ...base, read: false, cause: causeNow(folder, said.cause as RefusalCause, current[said.mode], said.permissionHeld), mode: said.mode }
}

/** In the order a tie is settled: the cause an admin can fix first, and last the two that need no fix. */
const CAUSES: readonly HealthCause[] = ["permission", "refusedWithPermission", "role", "license", "signedIn", "notRead", "notVerifiedYet", "reader"]

function verifiedOf(verdicts: readonly Verdict[]): VerifiedHealth {
  if (!verdicts.length) return { state: "noBackup", notVerified: [] }
  const latest = verdicts.reduce((newest, verdict) => (verdict.time > newest.time ? verdict : newest))
  const notRead = verdicts.flatMap((verdict) => (verdict.read ? [] : [verdict]))
  if (!notRead.length) return { state: "verified", at: latest.at, mode: latest.mode, notVerified: [] }
  const main = CAUSES.flatMap((cause) => notRead.filter((verdict) => verdict.cause === cause))[0]!
  return { state: notRead.length === verdicts.length ? "notVerified" : "partly", at: latest.at, cause: main.cause, mode: main.mode, notVerified: notRead.map((verdict) => verdict.folder) }
}

/**
 * The folders a connection lost access to: a folder it read before that two distinct runs refused
 * since. Two runs, because one refusal can be a passing answer. A run that left the folder out, or
 * failed to read it for another reason, says nothing and neither counts nor clears.
 *
 * It goes by what the connection keeps per folder (see keepEvidence), never by the list of its
 * last runs, so it does not matter which types the backups since then selected: the loss stands
 * until a run reads the folder again, or until the read or the refusals expire. `since` is the
 * first of those refusals; the cause is the one the latest of them found.
 */
function lostFolders(record: ConnectionRecord | undefined, now: Date): Map<string, Loss> {
  const lost = new Map<string, Loss>()
  if (!record) return lost
  for (const [folder, refusals] of Object.entries(record.refused)) {
    const readAt = folderValue(record.verified, folder)
    if (!recent(readAt, RUN_MAX_AGE_MS, now)) continue
    const byRun = new Map<string, FolderRefusal>()
    for (const refusal of refusals) {
      if (!byRun.has(refusal.runId) && recent(refusal.at, RUN_MAX_AGE_MS, now) && Date.parse(refusal.at) > Date.parse(readAt!)) byRun.set(refusal.runId, refusal)
    }
    const since = [...byRun.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    if (since.length >= 2) lost.set(folder, { since: since[0]!.at, cause: since.at(-1)!.cause, permissionHeld: since.at(-1)!.permissionHeld, mode: record.mode, clientId: record.clientId, ...(record.owner ? { owner: record.owner } : {}), ...(record.account ? { account: record.account } : {}), folder, runId: since[0]!.runId })
  }
  return lost
}

/** A folder a connection lost access to: since when, the cause its refusals found, and whose sign-in the connection is. */
interface Loss extends LossEpisode {
  permissionHeld?: boolean
  cause: RefusalCause
}

const key = (module: ServiceModule, area: PermissionArea) => `${module.id}/${area.id}`

interface Evaluated {
  service: ServiceHealth
  /** Per area key: the folders that lost access, since when, and the cause and sign-in of the connection that lost them. */
  lost: Map<string, Array<LossEpisode & { cause: LossCause }>>
  /** Per area key: whether its backup permissions are present; empty without a recent token. */
  ready: Record<string, boolean>
}

function evaluateService(module: ServiceModule, choice: ServiceChoice, granted: GrantedPermissions | undefined, evidence: Map<string, Entry[]>, lostBy: ReadonlyArray<Map<string, Loss>>, readerGranted: GrantedPermissions | undefined): Evaluated {
  const current = { delegated: granted, "app-only": readerGranted }
  const checks: AreaCheck[] | undefined = granted && checkModules(granted, [module])[0]!.areas
  const chosen = (area: PermissionArea) => !area.optIn || choice.areas[area.id] === true
  const state = (held: boolean | undefined): PermissionState => (held === undefined ? "unknown" : held ? "present" : "missing")
  const lost: Evaluated["lost"] = new Map()
  const ready: Evaluated["ready"] = {}
  const verdicts: Verdict[] = []
  const areas = module.areas.map((area, index): AreaHealth => {
    const enabled = choice.enabled && chosen(area)
    // A service or an area that is off is outside what backups cover: nothing is verified for it, and nothing is lost.
    const found = enabled ? area.folders.flatMap((folder) => verdictOf(folder, evidence.get(folder), current) ?? []) : []
    verdicts.push(...found)
    // A read by another connection never clears this connection's own loss.
    const gone = enabled ? area.folders.flatMap((folder) => lostBy.flatMap((folders) => {
      const loss = folders.get(folder)
      return loss ? [{ ...loss, folder, cause: causeNow(folder, loss.cause, current[loss.mode], loss.permissionHeld) }] : []
    })).sort((a, b) => Date.parse(a.since) - Date.parse(b.since)) : []
    if (gone.length) {
      lost.set(key(module, area), gone)
    }
    if (checks) ready[key(module, area)] = checks[index]!.backup
    return {
      id: area.id,
      label: area.label,
      optIn: area.optIn === true,
      personalData: area.personalData === true,
      enabled,
      permissions: state(checks?.[index]!.backup),
      restore: state(checks?.[index]!.restore),
      missing: granted ? areaPermissions(area, choice.access, "delegated", granted.permissions) : [],
      verified: verifiedOf(found),
      lostAccess: gone.length > 0,
      losses: gone.map(({ folder, since, cause, mode }) => ({ folder, since, cause, mode })),
    }
  })
  const considered = module.areas.flatMap((area, index) => (chosen(area) ? [index] : []))
  const optIn = module.areas.filter((area) => area.optIn && chosen(area)).map((area) => area.id)
  return {
    service: {
      id: module.id,
      label: module.label,
      enabled: choice.enabled,
      access: choice.access,
      hasTypes: WITH_TYPES.has(module.id),
      permissions: state(checks && considered.every((index) => checks[index]!.backup)),
      missing: granted ? missingForChoice({ [module.id]: { access: choice.access, ...(optIn.length ? { areas: optIn } : {}) } }, granted) : [],
      verified: verifiedOf(verdicts),
      areas,
    },
    lost,
    ready,
  }
}

const episodeKey = (loss: LossEpisode) => JSON.stringify([loss.clientId.toLowerCase(), loss.mode, loss.owner, loss.account, loss.folder, loss.since, loss.runId])
const episodeOf = ({ clientId, mode, owner, account, folder, since, runId }: LossEpisode): LossEpisode => ({ clientId, mode, ...(owner ? { owner } : {}), ...(account ? { account } : {}), folder, since, runId })
const sorted = (values: Iterable<string>) => [...values].sort()

/** The registration the tenant used before this one, when another is on record: the one seen last. */
function replacedFrom(input: HealthInput): Snapshot["replaces"] {
  const others = input.connections.filter((connection) => connection.mode === "delegated" && !sameId(connection.clientId, input.clientId))
  const previous = others.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  const permissions = previous && (previous.graph?.permissions ?? previous.snapshot?.permissions)
  return previous && { clientId: previous.clientId, ...(permissions ? { permissions: sorted(permissions) } : {}) }
}

export function evaluateHealth(input: HealthInput, now: Date): HealthEvaluation {
  const delegated = input.connections.find((connection) => connection.mode === "delegated" && sameId(connection.clientId, input.clientId))
  const reader = input.connections.find((connection) => connection.mode === "app-only" && sameId(connection.clientId, input.readerClientId))
  const token = delegated?.graph && recent(delegated.graph.at, TOKEN_MAX_AGE_MS, now) ? delegated.graph : undefined
  const granted: GrantedPermissions | undefined = token && !token.failure && token.permissions ? { kind: "delegated", permissions: new Set(token.permissions) } : undefined

  const readerToken = readerEvidence(input.reader, reader?.graph, now)
  const readerGranted: GrantedPermissions | undefined = readerToken?.permissions && !readerToken.failure && recent(readerToken.at, TOKEN_MAX_AGE_MS, now) ? { kind: "application", permissions: new Set(readerToken.permissions) } : undefined
  const evidence = evidenceOf([delegated, reader], now)
  const lostBy = [lostFolders(delegated, now), lostFolders(reader, now)]
  const evaluated = MODULES.map((module) => evaluateService(module, input.settings[module.id], granted, evidence, lostBy, readerGranted))
  const lost = new Map(evaluated.flatMap((entry) => [...entry.lost]))
  const ready: Record<string, boolean> = Object.assign({}, ...evaluated.map((entry) => entry.ready))

  const changes: HealthChange[] = []
  let baseline: Snapshot | undefined
  let current: Snapshot | undefined
  if (delegated) {
    const previous = delegated.snapshot
    const permissions = granted && sorted(granted.permissions)
    const held = new Set(permissions)
    const known: Snapshot = {
      at: now.toISOString(),
      ...(delegated.account ? { account: delegated.account } : {}),
      ...(permissions ? { permissions, ready } : {}),
      lost: sorted(lost.keys()),
      acknowledgedLosses: [...lost.values()].flat().map(episodeOf),
    }
    // The first snapshot of a connection, or the first one of another admin, is where comparing starts: it reports no change of its own.
    if (!previous || previous.account !== delegated.account) {
      const replaces = previous ? previous.replaces : replacedFrom(input)
      // Another admin's token is never compared with the earlier snapshot. What that snapshot had already found stays
      // listed until someone looks at it, dated from that snapshot.
      const carried = carryChanges(previous)
      baseline = { ...known, at: carried.length ? previous!.at : (token?.at ?? known.at), ...(replaces ? { replaces } : {}), ...(carried.length ? { carried } : {}) }
      changes.push(...carried)
    } else {
      baseline = { ...previous, ready: { ...previous.ready } }
      const found: PermissionChange[] = []
      if (permissions) {
        // What was not known at the snapshot is filled in now, without counting as a change.
        if (!previous.permissions) baseline.permissions = permissions
        else {
          const added = permissions.filter((permission) => !previous.permissions!.includes(permission))
          const removed = previous.permissions.filter((permission) => !held.has(permission))
          if (added.length) found.push({ kind: "permissionsAdded", permissions: added })
          if (removed.length) found.push({ kind: "permissionsRemoved", permissions: removed })
        }
        for (const entry of evaluated) {
          const arrived: string[] = []
          for (const [area, present] of Object.entries(entry.ready)) {
            if (previous.ready?.[area] === undefined) baseline.ready![area] = present
            else if (previous.ready[area] === false && present) arrived.push(area.slice(entry.service.id.length + 1))
          }
          // One line for a service whose areas that are on all have their permissions now, otherwise one per area.
          const chosen = entry.service.areas.filter((area) => !area.optIn || input.settings[entry.service.id].areas[area.id] === true).map((area) => area.id)
          const whole = entry.service.permissions === "present" && arrived.some((area) => chosen.includes(area))
          if (whole) found.push({ kind: "becameReady", service: entry.service.id })
          for (const area of arrived) if (!whole || !chosen.includes(area)) found.push({ kind: "becameReady", service: entry.service.id, area })
        }
        // Without a token to compare, what the last comparison found stands in the snapshot.
        if (found.length) baseline.found = found.map((change) => {
          // A repeated comparison must keep when the notice was first found, not today's check time.
          const earlier = previous.found?.find(({ foundAt: _foundAt, ...kept }) => JSON.stringify(kept) === JSON.stringify(change))
          return { ...change, foundAt: earlier?.foundAt ?? token!.at }
        })
        else delete baseline.found
      }
      changes.push(...(previous.carried ?? []), ...(baseline.found ?? []).map(({ foundAt: _foundAt, ...change }) => change))
      // Access that came back is forgotten, so losing it again is reported again.
      baseline.lost = previous.lost ? previous.lost.filter((area) => lost.has(area)) : known.lost
      const activeEpisodes = new Set(known.acknowledgedLosses!.map(episodeKey))
      baseline.acknowledgedLosses = previous.acknowledgedLosses ? previous.acknowledgedLosses.filter((loss) => activeEpisodes.has(episodeKey(loss))) : previous.lost ? [] : known.acknowledgedLosses
    }
    // A changed admin or registration cannot acknowledge a loss of the unchanged reader.
    if (reader?.snapshot?.acknowledgedLosses) {
      baseline.acknowledgedLosses = [...(baseline.acknowledgedLosses ?? []).filter((loss) => loss.mode === "delegated"), ...reader.snapshot.acknowledgedLosses]
    }
    const acknowledged = new Set((baseline.acknowledgedLosses ?? []).map(episodeKey))
    for (const entry of evaluated) {
      for (const [area, losses] of entry.lost) {
        const unseen = losses.filter((loss) => !acknowledged.has(episodeKey(loss)))
        if (!unseen.length) continue
        const main = CAUSES.flatMap((cause) => unseen.filter((loss) => loss.cause === cause))[0]!
        changes.push({ kind: "lostAccess", service: entry.service.id, area: area.slice(entry.service.id.length + 1), cause: main.cause, mode: main.mode, folders: [...new Set(unseen.map((loss) => loss.folder))], since: unseen[0]!.since })
      }
    }
    // Nothing differs from the snapshot, so it holds as of the answer that was compared with it.
    if (previous && !changes.length && !previous.replaces && permissions && token) baseline.at = token.at
    if (baseline.replaces) {
      const had = baseline.replaces.permissions
      changes.unshift({ kind: "registrationReplaced", previousClientId: baseline.replaces.clientId, lacks: had && permissions ? had.filter((permission) => !held.has(permission)) : [] })
    }
    // What is not known now keeps its last known value, so looking at the changes never forgets a permission.
    const { replaces: _replaces, found: _found, carried: _carried, ...kept } = baseline
    current = { ...kept, ...known, ready: { ...kept.ready, ...known.ready } }
  }

  return {
    report: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      evaluatedAt: now.toISOString(),
      graph: signInHealth(delegated?.graph, now),
      reader: readerHealth(input.reader, reader, now),
      storage: input.storage === "local" ? { state: "local", checkedAt: null } : signInHealth(delegated?.storage, now),
      services: evaluated.map((entry) => entry.service),
      changes,
      since: baseline?.at ?? null,
      granted: granted ? sorted(granted.permissions) : null,
    },
    ...(baseline ? { baseline } : {}),
    ...(current ? { current } : {}),
  }
}
