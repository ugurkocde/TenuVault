import { useEffect, useId, useRef, useState } from "react"
import { ChevronDown, FolderOpen, Loader2, Upload } from "lucide-react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { DAMAGE_KINDS, type DamageKind, type DamagedFileKinds } from "../../shared/damaged-files"
import type { RefreshOutcome } from "../lib/backup-list"
import { bridge } from "../lib/bridge"
import { announceBackupSettings } from "../lib/local-inventory"
import { NoticeCard } from "./NoticeCard"
import { RecoveryKeyImport } from "./RecoveryKeyImport"

interface DamagedBackupFilesNoticeProps {
  /** Files in the tenant's local backup folder that could not be read (the backup list's `damagedFiles`). */
  count: number
  /** The same files by why they cannot be used; null when the list did not say. */
  kinds: DamagedFileKinds | null
  /** The first encrypted file names on disk, listed when the reasons are not known. */
  names: string[]
  /** Backups in the list that are marked Unavailable. */
  unavailable: number
  /** The tenant, so Open backup folder shows its own folder. */
  tenantId?: string
  /** Lists the backups again after a key import; resolves with how that went. */
  onImported: () => Promise<RefreshOutcome>
  /** A request for the list shown is running (the backup list's `loading`). */
  listLoading?: boolean
  /** Why the last request for the list failed, empty when it succeeded (the backup list's `error`). */
  listError?: string
}

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`

/** The kinds when they describe every one of the count files; null when the reasons are not known. */
export function knownKinds(count: number, kinds: DamagedFileKinds | null): DamagedFileKinds | null {
  if (!kinds) return null
  const total = DAMAGE_KINDS.reduce((sum, kind) => sum + kinds.counts[kind], 0)
  return total > 0 && total === count ? kinds : null
}

/** The first paragraph of the notice: what is wrong with the files and what to do. Kinds are null when the reasons are not known. */
export function damagedFilesBody(count: number, kinds: DamagedFileKinds | null): string {
  const present = kinds ? DAMAGE_KINDS.filter((kind) => kinds.counts[kind] > 0) : []
  const one = count === 1
  const folder = `${files(count)} in this tenant's backup folder`
  if (present.length > 1) {
    return `TenuVault cannot read ${folder} for different reasons${kinds!.counts.key > 0 ? ", such as another device's recovery key" : ""}. Show file names lists them by reason.`
  }
  switch (present[0]) {
    case "key":
      return one
        ? `TenuVault cannot read ${folder}. It was most likely made with the recovery key of another device or an earlier installation, or it is damaged.`
        : `TenuVault cannot read ${folder}. They were most likely made with the recovery key of another device or an earlier installation, or they are damaged.`
    case "os":
      return `TenuVault cannot open ${folder}${kinds!.codes.length ? ` (${kinds!.codes.join(", ")})` : ""}. Check the folder's permissions and that a sync app has downloaded ${one ? "it" : "them"}, then select Refresh.`
    case "duplicate":
      return one
        ? `${folder} holds a backup item that another file also holds. Keep one copy of each, then select Refresh.`
        : `${folder} hold the same backup items twice. Keep one copy of each, then select Refresh.`
    case "damaged":
      return one
        ? `TenuVault cannot read ${folder} because it is damaged or incomplete. Restore it from a copy, then select Refresh.`
        : `TenuVault cannot read ${folder} because they are damaged or incomplete. Restore them from a copy, then select Refresh.`
    default:
      return one
        ? `TenuVault cannot read ${folder}. It may have been made with another recovery key, or it may be damaged.`
        : `TenuVault cannot read ${folder}. They may have been made with another recovery key, or they may be damaged.`
  }
}

/** The second paragraph: what still works, and the backups marked Unavailable. */
export function damagedFilesImpact(unavailable: number): string {
  const marked = unavailable > 0 ? `${unavailable === 1 ? "1 backup in this list is" : `${unavailable} backups in this list are`} marked Unavailable. ` : ""
  return `${marked}New backups are still saved. Older backups are not deleted until this is fixed.`
}

/** One line per kind in the file list when the files are damaged for different reasons. */
function kindLabel(kind: DamageKind, count: number, codes: string[]): string {
  switch (kind) {
    case "key":
      return `${count} made with another key or damaged`
    case "os":
      return `${count} could not be opened${codes.length ? ` (${codes.join(", ")})` : ""}`
    case "duplicate":
      return `${count} ${count === 1 ? "holds" : "hold"} the same backup item as another file`
    default:
      return `${count} damaged or incomplete`
  }
}

function FileNames({ names, more }: { names: string[]; more: number }) {
  return (
    <>
      {names.length > 0 && (
        <ul className="font-mono text-xs break-all">
          {names.map((name) => <li key={name}>{name}</li>)}
        </ul>
      )}
      {more > 0 && <p className="text-xs">and {more} more</p>}
    </>
  )
}

/**
 * Advisory only: shown above the Backup Timeline when files in the tenant's local backup folder
 * cannot be read, so some backups may be missing from the list or unavailable. Says why by the
 * kind of damage the store found, and offers what can fix it: a recovery key import when files
 * may have been made with another key, the tenant's folder, and the file names behind a disclosure.
 */
export function DamagedBackupFilesNotice({ count, kinds, names, unavailable, tenantId, onImported, listLoading = false, listError = "" }: DamagedBackupFilesNoticeProps) {
  const panelId = useId()
  const [expanded, setExpanded] = useState(false)
  const [importing, setImporting] = useState(false)
  // An import is running, or the list is read again after one.
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  const [openError, setOpenError] = useState("")
  // How the list read after an import went: "checked" once a current list arrived, "failed" when it
  // did not. Only a current list can say how many files still cannot be read.
  const [check, setCheck] = useState<"" | "checked" | "failed">("")
  const known = knownKinds(count, kinds)
  // Files a recovery key may open. When the reasons are not known, any of them may.
  const keyFiles = known ? known.counts.key : count
  useEffect(() => {
    if (!(count > 0) || keyFiles <= 0) setCheck("")
  }, [count, keyFiles])
  // Whether the list as of this render still has files a key may open. A check that ends after the
  // damage was resolved says nothing about damage found later, so it is dropped.
  const keyDamage = useRef(false)
  keyDamage.current = count > 0 && keyFiles > 0
  const endCheck = (result: "checked" | "failed") => setCheck(keyDamage.current ? result : "")
  // The list request as of this render, for the end of an import's refresh.
  const list = useRef({ loading: listLoading, error: listError })
  list.current = { loading: listLoading, error: listError }
  // Set when the import's refresh was replaced by a newer request that is still running: the check
  // then ends with that request.
  const waitingForList = useRef(false)
  const wasLoading = useRef(listLoading)
  useEffect(() => {
    const finished = wasLoading.current && !listLoading
    wasLoading.current = listLoading
    if (!finished) return
    if (waitingForList.current) {
      waitingForList.current = false
      setRefreshing(false)
      endCheck(listError ? "failed" : "checked")
      return
    }
    // A later request that succeeded, such as the timeline's Refresh, did check the backups again.
    if (!listError) setCheck((current) => (current === "failed" ? "" : current))
  }, [listLoading, listError])

  if (!(count > 0)) return null
  const present = known ? DAMAGE_KINDS.filter((kind) => known.counts[kind] > 0) : []

  const openFolder = async () => {
    setOpenError("")
    try {
      await bridge.backups.openFolder(tenantId)
    } catch (caught) {
      setOpenError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <NoticeCard
      role="status"
      className="mb-4"
      title="Some backups may be missing from this list"
      bodyClassName="max-w-3xl space-y-1"
      body={
        <>
          <p>{damagedFilesBody(count, known)}</p>
          <p>{damagedFilesImpact(unavailable)}</p>
        </>
      }
      actions={
        <>
          {keyFiles > 0 && (
            <Button type="button" variant="outline" size="sm" className="bg-white" disabled={pending || refreshing} onClick={() => setImporting((value) => !value)}>
              <Upload className="mr-2 h-4 w-4" /> Import recovery key
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="bg-white" onClick={() => void openFolder()}>
            <FolderOpen className="mr-2 h-4 w-4" /> Open backup folder
          </Button>
          <Button type="button" variant="outline" size="sm" className="bg-white" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}>
            <ChevronDown className={cn("mr-2 h-4 w-4 transition-transform", expanded && "rotate-180")} /> {expanded ? "Hide file names" : `Show file names (${count})`}
          </Button>
        </>
      }
    >
      {/* Rendered only while open, so a closed panel adds no space under the actions. */}
      {expanded && (
        <div id={panelId} className="max-w-3xl space-y-2">
          <p>These are the encrypted names on disk, so you can find the files. They do not match backup or policy names.</p>
          <div className="max-h-40 space-y-2 overflow-auto rounded-xl bg-white p-3">
            {known && present.length > 1
              ? present.map((kind) => (
                <div key={kind} className="space-y-1">
                  <p className="font-medium">{kindLabel(kind, known.counts[kind], known.codes)}</p>
                  <FileNames names={known.names[kind]} more={known.counts[kind] - known.names[kind].length} />
                </div>
              ))
              : <FileNames names={known && present[0] ? known.names[present[0]] : names} more={count - (known && present[0] ? known.names[present[0]] : names).length} />}
          </div>
          <p>If you have no copy and no recovery key, you can remove these files from the folder yourself. TenuVault never removes them for you.</p>
        </div>
      )}
      {importing && keyFiles > 0 && (
        <RecoveryKeyImport
          onImported={(next) => {
            setImporting(false)
            setError("")
            setCheck("")
            announceBackupSettings(next)
            setRefreshing(true)
            // The card is keyed by tenant and storage, so a refresh that ends after a switch only
            // updates the card it was started from, which is gone by then.
            void onImported().then((outcome) => {
              if (outcome === "superseded") {
                // A newer request for the same list replaced this one; its answer is the check.
                if (list.current.loading) {
                  waitingForList.current = true
                  return
                }
                endCheck(list.current.error ? "failed" : "checked")
              } else {
                endCheck(outcome === "updated" ? "checked" : "failed")
              }
              setRefreshing(false)
            }, () => {
              endCheck("failed")
              setRefreshing(false)
            })
          }}
          onError={setError}
          onBusyChange={setPending}
        />
      )}
      {refreshing && (
        <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking the backups again...</p>
      )}
      {check === "checked" && !refreshing && keyFiles > 0 && (
        <p className="text-red-700">
          {keyFiles === 1
            ? "This device still cannot read this file. It needs a different recovery key, or a copy from before it was damaged."
            : `This device still cannot read ${keyFiles} of these files. They need a different recovery key, or a copy from before they were damaged.`}
        </p>
      )}
      {check === "failed" && !refreshing && <p className="text-red-700">The backups could not be checked again. Select Refresh to try again.</p>}
      {error && <p className="text-red-700">{error}</p>}
      {openError && <p className="text-red-700">{openError}</p>}
    </NoticeCard>
  )
}
