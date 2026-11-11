import { useEffect, useId, useState } from "react"
import { ChevronDown, FolderOpen, Loader2, Upload } from "lucide-react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import { DAMAGE_KINDS, type DamageKind, type DamagedFileKinds } from "../../shared/damaged-files"
import { bridge } from "../lib/bridge"
import { announceBackupSettings } from "../lib/local-inventory"
import { NoticeCard } from "./NoticeCard"
import { RecoveryKeyImport } from "./RecoveryKeyImport"

interface DamagedBackupFilesNoticeProps {
  /** Files in the tenant's local backup folder that could not be read (the backup list's `damagedFiles`). */
  count: number
  /** The same files by why they cannot be used; null when the list did not say. */
  kinds: DamagedFileKinds | null
  /** The first encrypted file names on disk, for a list that did not send kinds. */
  names: string[]
  /** Backups in the list that are marked Unavailable. */
  unavailable: number
  /** The tenant, so Open backup folder shows its own folder. */
  tenantId?: string
  /** Lists the backups again after a key import; resolves when the new list arrived. */
  onImported: () => Promise<void>
}

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`

/** The first paragraph of the notice: what is wrong with the files and what to do. */
export function damagedFilesBody(count: number, kinds: DamagedFileKinds): string {
  const present = DAMAGE_KINDS.filter((kind) => kinds.counts[kind] > 0)
  const one = count === 1
  if (present.length > 1) {
    return `TenuVault cannot read ${files(count)} in this tenant's backup folder, for different reasons. Show file names lists them by reason.${kinds.counts.key > 0 ? " Some may have been made with a different recovery key, for example by another device or an earlier installation." : ""}`
  }
  switch (present[0]) {
    case "key":
      return one
        ? "TenuVault cannot read 1 file in this tenant's backup folder. Most often it was made with a different recovery key, for example by another device or an earlier installation. It can also be damaged."
        : `TenuVault cannot read ${files(count)} in this tenant's backup folder. Most often they were made with a different recovery key, for example by another device or an earlier installation. They can also be damaged.`
    case "os":
      return `TenuVault cannot open ${files(count)} in this tenant's backup folder${kinds.codes.length ? ` (${kinds.codes.join(", ")})` : ""}. Check the folder's permissions, and that a sync app has downloaded the files, then select Refresh.`
    case "duplicate":
      return one
        ? "1 file in this tenant's backup folder holds a backup item that another file also holds, for example after a backup folder was copied in by hand. Keep one copy of each, then select Refresh."
        : `${files(count)} in this tenant's backup folder hold the same backup item twice, for example after a backup folder was copied in by hand. Keep one copy of each, then select Refresh.`
    default:
      return one
        ? "TenuVault cannot read 1 file in this tenant's backup folder. It is damaged or incomplete. Restore it from a copy, then select Refresh."
        : `TenuVault cannot read ${files(count)} in this tenant's backup folder. They are damaged or incomplete. Restore them from a copy, then select Refresh.`
  }
}

/** The second paragraph: what still works, and the backups marked Unavailable. */
export function damagedFilesImpact(unavailable: number): string {
  const marked = unavailable > 0 ? `${unavailable === 1 ? "1 backup in this list is" : `${unavailable} backups in this list are`} marked Unavailable. ` : ""
  return `${marked}Your other backups work and new backups are still saved. Until this is fixed, older backups are not deleted.`
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
export function DamagedBackupFilesNotice({ count, kinds, names, unavailable, tenantId, onImported }: DamagedBackupFilesNoticeProps) {
  const panelId = useId()
  const [expanded, setExpanded] = useState(false)
  const [importing, setImporting] = useState(false)
  // An import is running, or the list is read again after one.
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  const [openError, setOpenError] = useState("")
  // Set when the list after an import still has files that may need a key; cleared once none are left.
  const [checked, setChecked] = useState(false)
  const breakdown: DamagedFileKinds = kinds ?? { counts: { key: 0, os: 0, duplicate: 0, damaged: count }, codes: [], names: { key: [], os: [], duplicate: [], damaged: names } }
  const keyFiles = breakdown.counts.key
  useEffect(() => {
    if (!(count > 0) || keyFiles <= 0) setChecked(false)
  }, [count, keyFiles])

  if (!(count > 0)) return null
  const present = DAMAGE_KINDS.filter((kind) => breakdown.counts[kind] > 0)
  const mixed = present.length > 1

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
          <p>{damagedFilesBody(count, breakdown)}</p>
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
            {mixed
              ? present.map((kind) => (
                <div key={kind} className="space-y-1">
                  <p className="font-medium">{kindLabel(kind, breakdown.counts[kind], breakdown.codes)}</p>
                  <FileNames names={breakdown.names[kind]} more={breakdown.counts[kind] - breakdown.names[kind].length} />
                </div>
              ))
              : <FileNames names={breakdown.names[present[0]!]} more={count - breakdown.names[present[0]!].length} />}
          </div>
          <p>If you have no copy and no recovery key, you can remove these files from the folder yourself. TenuVault never removes them for you.</p>
        </div>
      )}
      {importing && keyFiles > 0 && (
        <RecoveryKeyImport
          onImported={(next) => {
            setImporting(false)
            setError("")
            announceBackupSettings(next)
            setRefreshing(true)
            void onImported().finally(() => {
              setRefreshing(false)
              setChecked(true)
            })
          }}
          onError={setError}
          onBusyChange={setPending}
        />
      )}
      {refreshing && (
        <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking the backups again...</p>
      )}
      {checked && !refreshing && keyFiles > 0 && (
        <p className="text-red-700">
          {keyFiles === 1
            ? "This device still cannot read this file. It needs a different recovery key, or a copy from before it was damaged."
            : `This device still cannot read ${keyFiles} of these files. They need a different recovery key, or a copy from before they were damaged.`}
        </p>
      )}
      {error && <p className="text-red-700">{error}</p>}
      {openError && <p className="text-red-700">{openError}</p>}
    </NoticeCard>
  )
}
