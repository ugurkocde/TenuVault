import { useEffect, useState } from "react"
import { Button } from "~/components/ui/button"
import { typeForFolder } from "../../../shared/intune/registry"

interface Page { changes: Array<{ id: string; change: string }>; examined: number; unchanged: number; next: [number, number] | null }
/** Inventory browsing reads one bounded window and replaces it on navigation. */
export function LargeComparison({ credentials, backupId, baseline, folders }: { credentials: Record<string, unknown>; backupId: string; baseline: string; folders: string[] }) {
  const [folder, setFolder] = useState(folders[0] ?? "")
  const [cursor, setCursor] = useState<[number, number]>([0, 0])
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState("")
  const connection = JSON.stringify(credentials)
  const tenant = credentials.tenantId
  const storage = credentials.storageAccountName
  useEffect(() => { setFolder(folders[0] ?? ""); setCursor([0, 0]); setPage(null) }, [tenant, storage, backupId, baseline, folders.join(",")])
  useEffect(() => {
    if (!folder) return
    const controller = new AbortController()
    setPage(null); setError("")
    void fetch("/api/large-backup-page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...credentials, backupId, baseline, folder, cursor }), signal: controller.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "Inventory could not be compared")
      if (!controller.signal.aborted) setPage(result)
    }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => controller.abort()
  }, [connection, tenant, storage, backupId, baseline, folder, cursor[0], cursor[1]])
  if (!folders.length) return null
  return <div className="space-y-3 rounded-2xl bg-blue-50 p-5 text-sm text-blue-900">
    <p className="font-medium">Large inventory comparison</p>
    <p>Inventory is compared in pages. Policy totals above exclude this inventory. Each page checks at most 1,000 objects and shows at most 200 changes.</p>
    <label>Inventory <select className="rounded border bg-white p-2 text-gray-900" value={folder} onChange={event => { setFolder(event.target.value); setCursor([0, 0]) }}>{folders.map(value => <option key={value} value={value}>{typeForFolder(value)?.label ?? value}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
    {!page && !error && <p>Reading inventory page...</p>}
    {page && <><p>{page.examined} objects checked, {page.unchanged} unchanged on this page.</p><ul className="max-h-80 overflow-auto">{page.changes.map(change => <li className="break-all py-1 font-mono" key={change.id}>{change.id}: {change.change}</li>)}</ul><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!cursor[0] && !cursor[1]} onClick={() => setCursor([0, 0])}>First page</Button><Button variant="outline" size="sm" disabled={!page.next} onClick={() => { if (page.next) setCursor(page.next) }}>Next page</Button></div></>}
  </div>
}

export function LargeContents({ credentials, backupId }: { credentials: Record<string, unknown>; backupId: string }) {
  const [page, setPage] = useState(0)
  const [data, setData] = useState<{ hasMore: boolean; groups: Array<{ folder: string; label: string; count: number; policies: Array<{ path: string; displayName: string }> }> } | null>(null)
  const [error, setError] = useState("")
  const connection = JSON.stringify(credentials)
  const tenant = credentials.tenantId, storage = credentials.storageAccountName
  useEffect(() => { setPage(0); setData(null) }, [tenant, storage, backupId])
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setError("")
    void fetch("/api/list-backup-contents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...credentials, subscriptionId: "local", resourceGroupName: "local", backupId, largePage: page }), signal: controller.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "Inventory could not be read")
      if (!controller.signal.aborted) setData({ hasMore: result.hasMore === true, groups: result.content.groups.filter((group: { folder: string }) => result.content.metadata.LargeItems[group.folder]) })
    }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => controller.abort()
  }, [connection, tenant, storage, backupId, page])
  return <div className="space-y-3 rounded-2xl bg-blue-50 p-5 text-sm text-blue-900"><p className="font-medium">Large inventory, page {page + 1}</p>{error && <p role="alert">{error}</p>}{data?.groups.map(group => <details key={group.folder}><summary>{group.label}: {group.count.toLocaleString()} objects</summary><ul className="max-h-64 overflow-auto">{group.policies.map(item => <li className="break-all py-1 font-mono" key={item.path}>{item.displayName}</li>)}</ul></details>)}<div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={page === 0 || !data} onClick={() => setPage(value => value - 1)}>Previous page</Button><Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage(value => value + 1)}>Next page</Button></div></div>
}
