import { Suspense, lazy, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Layers } from "lucide-react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { useLicense, useTenantPlan } from "../lib/license"
import { canUse, GatedButton, LockedPreview } from "../components/PlanGate"
import { showFeaturePlanError } from "../lib/plan-dialog"
import { toast } from "../lib/toast"
import { createFromSnapshot, listCustomBaselines, listSnapshots, type SnapshotOption } from "../features/custom-baselines/api"

const BaselineDetail = lazy(() => import("../features/custom-baselines/BaselineDetail"))

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
const inputClass = "h-10 w-full rounded-full border border-gray-200 bg-white px-4 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

const PREVIEW = {
  summary: "Your organization's own Settings Catalog baselines: customize an OpenIntuneBaseline release or turn a complete backup into a company baseline, edit it in versions and deploy it through a reviewed change set.",
  points: [
    "Immutable versions with a change note; secret values are never stored or deployed.",
    "Rebase onto a newer OIB release with a three-way comparison; conflicts need your decision.",
    "Compare a baseline with OIB, NCSC, your policy packs and native frameworks without reading the tenant.",
  ],
}

/**
 * My baselines: custom baselines of the selected tenant (Pro and MSP). The list is readable on
 * every plan; creating, editing, deploying and comparing need customBaselines.
 */
export default function BaselinesPage() {
  const { baselineId } = useParams()
  const { selectedTenant } = useSelectedTenant()
  const tenantId = selectedTenant?.credentials?.tenantId
  const plan = useTenantPlan(tenantId)
  const allowed = canUse(plan, "customBaselines")
  const licenseKnown = useLicense().status !== null
  const navigate = useNavigate()
  const list = useQuery({ queryKey: ["custom-baselines", tenantId], queryFn: () => listCustomBaselines(selectedTenant!), enabled: !!tenantId, retry: false })
  const baselines = list.data?.baselines ?? []

  if (!selectedTenant) return <div className="mx-auto max-w-6xl p-6 lg:p-8"><p className="rounded-3xl bg-card p-6 text-sm text-gray-600">Connect or select a tenant to see its baselines.</p></div>

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <div>
        <Link to="/portal/frameworks" className="text-sm text-blue-700 hover:underline dark:text-blue-400">Frameworks</Link>
        <h1 className="mt-2 flex items-center gap-3 text-4xl font-light tracking-tight text-gray-900 dark:text-gray-100"><Layers className="h-8 w-8" aria-hidden="true" />My baselines</h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400">Baselines of {selectedTenant.name}. A baseline belongs to the tenant it was created in. Nothing here changes the tenant until you approve and apply a deployment change set.</p>
      </div>
      {licenseKnown && !allowed && <LockedPreview feature="customBaselines" summary={PREVIEW.summary} points={PREVIEW.points} />}

      {baselineId ? (
        <Suspense fallback={<div className="h-24 animate-pulse rounded-3xl bg-card" />}>
          <BaselineDetail key={`${baselineId}:${selectedTenant.id}`} tenant={selectedTenant} baselineId={baselineId} allowed={allowed} plan={plan} deployments={(list.data?.deployments ?? []).filter((entry) => entry.baselineId === baselineId)} comparisons={(list.data?.comparisons ?? []).filter((entry) => entry.baselineId === baselineId)} onChanged={() => void list.refetch()} />
        </Suspense>
      ) : (
        <>
          <section aria-label="Create a baseline" className={card}>
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Create a baseline</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 rounded-2xl border border-gray-100 p-4 dark:border-gray-800">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Customize OpenIntuneBaseline</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">Choose a platform under Your own baseline in the OpenIntuneBaseline section and select Customize. The exact OIB commit is recorded as the base of later upgrades.</p>
                <Button type="button" variant="outline" onClick={() => navigate("/portal/oib")}>Open OpenIntuneBaseline</Button>
              </div>
              <SnapshotCreator key={selectedTenant.id} tenant={selectedTenant} allowed={allowed} plan={plan} onCreated={(id) => { void list.refetch(); navigate(`/portal/baselines/${id}`) }} />
            </div>
          </section>

          <section aria-label="Baselines" className={card}>
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">{allowed ? "Baselines" : "Stored baselines (read-only)"}</h2>
            {list.isLoading && <div className="h-16 animate-pulse rounded-2xl bg-gray-100 dark:bg-gray-800" />}
            {list.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{list.error instanceof Error ? list.error.message : "Baselines could not be loaded."}</p>}
            {list.data && !baselines.length && <p className="text-sm text-gray-600 dark:text-gray-400">No baseline yet.</p>}
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {baselines.map((baseline) => (
                <li key={baseline.id}>
                  <Link to={`/portal/baselines/${baseline.id}`} className="flex flex-wrap items-center gap-3 rounded-2xl px-2 py-3 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 dark:hover:bg-gray-900">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">{baseline.name}</span>
                      <span className="block text-xs text-gray-500">{baseline.summary}</span>
                    </span>
                    <Chip tone="neutral">{baseline.origin === "oib" ? "from OIB" : "from snapshot"}</Chip>
                    <Chip tone="coral">v{baseline.currentVersion}</Chip>
                    {baseline.latestKnownRelease && <Chip tone="warning">newer OIB version</Chip>}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}

function SnapshotCreator({ tenant, allowed, plan, onCreated }: { tenant: NonNullable<ReturnType<typeof useSelectedTenant>["selectedTenant"]>; allowed: boolean; plan: ReturnType<typeof useTenantPlan>; onCreated: (id: string) => void }) {
  const [snapshots, setSnapshots] = useState<SnapshotOption[] | null>(null)
  const [backupId, setBackupId] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      showFeaturePlanError(error)
      toast(error instanceof Error ? error.message : "The request failed.", "error")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-2xl border border-gray-100 p-4 dark:border-gray-800">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Company baseline from a backup</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">Uses the Settings Catalog policies of a complete backup of this tenant, without IDs, assignments or scope tags. Masked secrets are marked as not portable and are never deployed.</p>
      {!snapshots ? (
        <GatedButton feature="customBaselines" plan={plan} variant="outline" disabled={busy} onClick={() => void run(async () => setSnapshots((await listSnapshots(tenant)).snapshots))}>Choose a backup</GatedButton>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs text-gray-500">Backup
            <select className={inputClass} value={backupId} onChange={(event) => setBackupId(event.target.value)}>
              <option value="">Choose a complete backup</option>
              {snapshots.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.usable}>{entry.id}{entry.usable ? "" : ` (${entry.status}, not complete)`}</option>)}
            </select>
          </label>
          <label className="block text-xs text-gray-500">Name<input className={inputClass} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="For example: Contoso workstation standard" /></label>
          <Button type="button" disabled={busy || !backupId || !allowed} onClick={() => void run(async () => {
            const { baseline } = await createFromSnapshot(tenant, backupId, name.trim() || undefined)
            toast("Company baseline created as version 1.", "success")
            onCreated(baseline.id)
          })}>{busy ? "Reading the backup" : "Create company baseline"}</Button>
          {!snapshots.length && <p className="text-xs text-gray-500">No backup is available. Run a backup first.</p>}
        </div>
      )}
    </div>
  )
}
