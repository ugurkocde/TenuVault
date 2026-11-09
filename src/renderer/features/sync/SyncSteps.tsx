import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Check, Info, RefreshCw, ShieldCheck } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { cn } from "~/lib/utils"
import { bridge } from "../../lib/bridge"
import { settingsHref } from "../../lib/settings-section"
import { MAX_SYNC_POLICIES, SYNC_TYPES, type PolicyOption, type SyncBackup, type SyncTarget, type SyncTargetOption } from "./api"
import { initials, plural, readiness, reviewRows, ROW_LABEL, type ReviewState, type Tone } from "./model"
import { Skeleton, Spinner, stillReading, useElapsed } from "./loading"

export const card = "rounded-3xl bg-card shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
const fieldClass = "h-10 w-full rounded-full border border-gray-200 bg-white px-4 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"

export const STEPS = ["Choose settings", "Choose targets", "Review", "Sync"] as const

/**
 * The four steps; finished steps show a check, and the connector before a step fills once the
 * step before it is done.
 */
export function Stepper({ step }: { step: number }) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-y-2">
      {STEPS.map((label, index) => {
        const number = index + 1
        const current = number === step
        const done = number < step
        return (
          <li key={label} aria-current={current ? "step" : undefined} className="flex items-center">
            {index > 0 && (
              <span aria-hidden="true" className="mx-1 block h-0.5 w-3 overflow-hidden rounded-full bg-border lg:mx-1.5 lg:w-8">
                <span className={cn("sync-fill block h-full rounded-full bg-green-600", number <= step ? "scale-x-100" : "scale-x-0")} />
              </span>
            )}
            <span className={cn("flex h-10 items-center gap-2 rounded-full pl-1.5 pr-4 text-sm font-medium transition-colors duration-300", current ? "bg-primary text-primary-foreground" : "bg-card text-gray-700")}>
              <span className={cn("flex size-7 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-300", done ? "bg-green-600 text-white" : current ? "bg-white/15" : "bg-secondary")}>
                {done ? <Check className="sync-pop h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" /> : number}
              </span>
              {label}
              {done && <span className="sr-only">(done)</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function CardHead({ title, description, children }: { title: string; description: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-4 px-6 pb-3 pt-6">
      <div className="min-w-60 flex-1">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-gray-600">{description}</p>
      </div>
      {children}
    </div>
  )
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-6 pt-4">{children}</div>
}

export interface SelectedPolicy { folder: string; sourceId: string; name: string; platforms: string | null }

/** Step 1: the source tenant, the policy type tabs and the policies with their sync status. */
export function ChooseSettings({ sources, sourceId, onSource, folder, onFolder, policies, loading, error, selected, onToggle, status, onNext }: {
  sources: Tenant[]
  sourceId: string
  onSource: (tenantId: string) => void
  folder: string
  onFolder: (folder: string) => void
  policies: PolicyOption[]
  loading: boolean
  error: string | null
  selected: Record<string, SelectedPolicy>
  onToggle: (policy: PolicyOption) => void
  status: (policy: PolicyOption) => { label: string; tone: Tone; title?: string } | null
  onNext: () => void
}) {
  const count = Object.keys(selected).length
  const full = count >= MAX_SYNC_POLICIES
  return (
    <section aria-label="Choose settings" className={card}>
      <CardHead title="What should be synced?" description="Settings are read live from the source tenant.">
        <label className="flex min-w-64 flex-col gap-1.5 text-xs font-medium text-gray-500">
          Source tenant
          <select className={fieldClass} value={sourceId} onChange={(event) => onSource(event.target.value)}>
            {sources.map((tenant) => <option key={tenant.credentials!.tenantId} value={tenant.credentials!.tenantId.toLowerCase()}>{tenant.name}{tenant.domain ? ` (${tenant.domain})` : ""}</option>)}
          </select>
        </label>
      </CardHead>
      <div role="group" aria-label="Policy type" className="flex flex-wrap gap-2 px-6 pb-3">
        {SYNC_TYPES.map((type) => {
          const picked = Object.values(selected).filter((policy) => policy.folder === type.folder).length
          return (
            <button key={type.folder} type="button" aria-pressed={folder === type.folder} onClick={() => onFolder(type.folder)} className={cn("h-9 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", folder === type.folder ? "bg-primary text-primary-foreground" : "bg-secondary text-gray-700 hover:bg-accent")}>
              {type.label}{picked ? ` (${picked})` : ""}
            </button>
          )
        })}
      </div>
      <div className="px-4">
        {loading && (
          <ul aria-busy="true" aria-label="Loading policies" className="space-y-1">
            {["w-64", "w-52", "w-72", "w-56", "w-44"].map((width) => (
              <li key={width} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl p-3">
                <Skeleton className="size-4 rounded-md" />
                <span className="space-y-2">
                  <Skeleton className={cn("h-3.5 max-w-full", width)} />
                  <Skeleton className="h-3 w-28" />
                </span>
                <Skeleton className="h-6 w-24" />
              </li>
            ))}
          </ul>
        )}
        {error && <p className="px-2 text-sm text-red-700">{error}</p>}
        {!loading && !error && !policies.length && <p className="px-2 py-3 text-sm text-gray-600">This tenant has no policies of this type.</p>}
        {policies.length > 0 && (
          <ul className="max-h-[26rem] space-y-1 overflow-y-auto">
            {policies.map((policy) => {
              const chosen = `${policy.folder}:${policy.id.toLowerCase()}` in selected
              const chip = status(policy)
              return (
                <li key={policy.id}>
                  <label className={cn("grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl p-3 transition-colors", chosen ? "bg-blue-50" : "hover:bg-gray-50", !chosen && full && "cursor-not-allowed opacity-60")}>
                    <input type="checkbox" className="h-4 w-4" checked={chosen} disabled={!chosen && full} onChange={() => onToggle(policy)} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-900">{policy.name}</span>
                      <span className="block truncate text-xs text-gray-500">{SYNC_TYPES.find((type) => type.folder === policy.folder)?.label ?? policy.folder}{policy.platforms ? `, ${policy.platforms}` : ""}</span>
                    </span>
                    {chip ? <span key={chip.label} className="sync-fade inline-flex"><Chip tone={chip.tone} title={chip.title}>{chip.label}</Chip></span> : <span className="flex"><Skeleton className="h-6 w-24" /><span className="sr-only">Checking</span></span>}
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <Footer>
        <span className="text-sm text-gray-500">{count ? `${count} selected. ` : ""}Up to {MAX_SYNC_POLICIES} per sync.</span>
        <Button type="button" disabled={!count} onClick={onNext}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {count ? `Sync ${plural(count, "policy", "policies")}` : "Sync"}
        </Button>
      </Footer>
    </section>
  )
}

const REASON: Record<NonNullable<SyncTargetOption["reason"]>, { chip: string; title: string }> = {
  msp: { chip: "MSP", title: "Syncing to this tenant is part of MSP." },
  plan: { chip: "Plan without Sync", title: "This tenant's plan does not include Sync." },
  unavailable: { chip: "Not available", title: "Sign in to this tenant and check its license first." },
}

/** Step 2: every other connected tenant as a card; on Pro only the other tenant of the license can be chosen. */
export function ChooseTargets({ sourceName, options, loading, error, tenantOf, linked, selected, onToggle, onBack, onNext, planning }: {
  sourceName: string
  options: SyncTargetOption[]
  loading: boolean
  error: string | null
  tenantOf: (tenantId: string) => Tenant | undefined
  linked: Record<string, number>
  selected: string[]
  onToggle: (option: SyncTargetOption) => void
  onBack: () => void
  onNext: () => void
  planning: boolean
}) {
  const mspOnly = options.some((option) => option.reason === "msp")
  return (
    <section aria-label="Choose targets" className={card}>
      <CardHead title="Where should these settings go?" description={`Pick the tenants to sync to. ${sourceName} does not change.`} />
      <div className="px-6 pb-3">
        {loading && (
          <div aria-busy="true" aria-label="Checking the tenants" className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
            {[0, 1, 2].map((index) => (
              <div key={index} className="space-y-3 rounded-2xl bg-gray-50 p-4">
                <Skeleton className="size-9 bg-gray-200" />
                <Skeleton className="h-3.5 w-32 bg-gray-200" />
                <Skeleton className="h-3 w-24 bg-gray-200" />
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-red-700">{error}</p>}
        {!loading && !error && !options.length && <p className="text-sm text-gray-600">Connect another tenant to sync to it.</p>}
        {options.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
            {options.map((option) => {
              const tenant = tenantOf(option.tenantId)
              const name = tenant?.name ?? option.tenantId
              const chosen = selected.includes(option.tenantId)
              const reason = option.reason ? REASON[option.reason] : null
              const count = linked[option.tenantId] ?? 0
              return (
                <button
                  key={option.tenantId}
                  type="button"
                  aria-pressed={chosen}
                  aria-disabled={!option.eligible || undefined}
                  title={reason?.title}
                  onClick={() => onToggle(option)}
                  className={cn("rounded-2xl border-2 p-4 text-left transition-[border-color,background-color,box-shadow,transform] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", chosen ? "border-coral-500 bg-blue-50" : "border-transparent bg-gray-50", option.eligible ? "motion-safe:hover:-translate-y-0.5 hover:shadow-[0_6px_20px_-8px_rgba(22,21,20,0.25)]" : "cursor-not-allowed opacity-70")}
                >
                  <span className="flex items-center justify-between">
                    <span className="flex size-9 items-center justify-center rounded-full bg-card text-[11px] font-bold text-gray-700">{initials(name)}</span>
                    {option.eligible && <span aria-hidden="true" className={cn("flex size-5 items-center justify-center rounded-md border-2", chosen ? "border-coral-500 bg-coral-500 text-white" : "border-gray-400 bg-card")}>{chosen && <Check className="h-3 w-3" strokeWidth={3} />}</span>}
                  </span>
                  <span className="mt-3 block truncate text-sm font-semibold text-gray-900">{name}</span>
                  <span className="block truncate text-xs text-gray-500">{tenant?.domain || option.tenantId}</span>
                  <span className="mt-3 flex min-h-6 flex-wrap gap-1.5">
                    {option.eligible && !option.multiple && <Chip>On your Pro license</Chip>}
                    {reason && <Chip>{reason.chip}</Chip>}
                    {count > 0 && <Chip tone="success">{plural(count, "policy", "policies")} linked</Chip>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {mspOnly && (
          <p className="mt-3 flex items-center gap-2.5 rounded-2xl bg-secondary px-4 py-3 text-sm text-gray-700">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Pro syncs between the two tenants of your license. Syncing to more tenants is part of MSP.{" "}
              <button type="button" className="font-semibold underline underline-offset-2" onClick={() => void bridge.license.open("buy", { source: "sync-targets" })}>See plans</button>
            </span>
          </p>
        )}
      </div>
      <Footer>
        <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
        <Button type="button" disabled={!selected.length || planning} onClick={onNext}>
          {planning ? "Reading the tenants" : selected.length ? `Review ${plural(selected.length, "tenant", "tenants")}` : "Review"}
        </Button>
      </Footer>
    </section>
  )
}

const NOTE_TONE = { danger: "text-red-700", warning: "text-amber-800", neutral: "text-gray-500" } as const

/** Step 3: what each target gets, why a target is left out, the secret acknowledgement and the backup choice. */
export function ReviewStep({ targets, reviews, planning, planError, reading, tenantOf, backup, onBackup, secrets, ack, onAck, onBack, onApprove, busy }: {
  targets: SyncTarget[]
  /** What the plan reads while it runs: the source tenant and how many targets. */
  reading: { source: string; targets: number }
  reviews: Record<string, ReviewState>
  planning: boolean
  planError: string | null
  tenantOf: (tenantId: string) => Tenant | undefined
  backup: SyncBackup
  onBackup: (backup: SyncBackup) => void
  secrets: { needed: boolean; acknowledged: boolean }
  ack: boolean
  onAck: (checked: boolean) => void
  onBack: () => void
  onApprove: () => void
  busy: boolean
}) {
  const states = targets.map((target) => readiness(target, reviews[target.targetTenantId], backup, !!tenantOf(target.targetTenantId)?.resources?.storageAccountName))
  const ready = states.filter((state) => state.state === "ready").length
  const inSync = states.filter((state) => state.state === "in-sync").length
  const checking = planning || states.some((state) => state.state === "checking")
  const gated = secrets.needed && !(ack && secrets.acknowledged)
  // Nothing is written when no target has a change to review: the backup choice does not apply.
  const writes = planning || targets.some((target) => !!target.changeSet && target.promotion?.status !== "blocked")
  const option = (value: SyncBackup, label: string, description: ReactNode) => (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-sm", backup === value ? "border-primary bg-blue-50/60" : "border-gray-200")}>
      <input type="radio" name="sync-backup" value={value} checked={backup === value} onChange={() => onBackup(value)} className="mt-1 h-4 min-h-0 w-4 shrink-0" />
      <span><span className="font-medium text-gray-900">{label}</span><span className="mt-1 block text-xs leading-5 text-gray-600">{description}</span></span>
    </label>
  )
  return (
    <section aria-label="Review" className={card}>
      <CardHead title="Review against each target" description="TenuVault read every target tenant. Nothing is written until you approve." />
      <div className="space-y-3 px-6">
        {planError && <p role="alert" className="rounded-2xl bg-red-50 p-3 text-sm text-red-800">{planError}</p>}
        {planning && !targets.length && <PlanningPanel source={reading.source} targets={reading.targets} />}
        {targets.map((target, index) => {
          const tenant = tenantOf(target.targetTenantId)
          const name = tenant?.name ?? target.targetTenantId
          const state = states[index]!
          const review = reviews[target.targetTenantId]
          const rows = reviewRows(target, review?.preview ?? null)
          const changes = rows.filter((row) => row.kind === "create" || row.kind === "update").length
          return (
            <div key={target.targetTenantId} className="sync-node overflow-hidden rounded-2xl bg-gray-50" style={{ animationDelay: `${index * 60}ms` }}>
              <header className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-card text-[11px] font-bold text-gray-700">{initials(name)}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-gray-900">{name}</span><span className="block truncate text-xs text-gray-500">{tenant?.domain}</span></span>
                <span key={state.state} className="sync-fade inline-flex">
                  {state.state === "ready" ? <Chip tone="success">Ready: {plural(changes, "change", "changes")}</Chip> : state.state === "in-sync" ? <Chip tone="success">Already in sync</Chip> : state.state === "checking" ? <Chip>Checking</Chip> : <Chip tone="danger">Left out</Chip>}
                </span>
              </header>
              {state.reason && <p className="border-t border-gray-200 px-4 py-2.5 text-sm text-red-700">{state.reason}</p>}
              {backup === "none" && !tenant?.resources?.storageAccountName && state.state === "ready" && <p className="border-t border-gray-200 px-4 py-2.5 text-sm text-amber-800">Rollback needs backup storage in this tenant. Without it, this sync cannot be rolled back from TenuVault.</p>}
              {state.state === "checking" ? <CheckingRows count={Math.max(1, rows.length)} /> : (
              <ul className="sync-fade">
                {rows.map((row) => (
                  <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-t border-gray-200 px-4 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="block text-gray-900">{row.name}</span>
                      {row.kind === "same" && <span className="block text-xs text-gray-500">No setting differs from the policy in this tenant. It is written again unchanged.</span>}
                      {row.kind === "skip" && <span className="block text-xs text-gray-500">Neither this policy nor its synced copy changed since the last sync. Nothing is written.</span>}
                      {row.notes.map((note, noteIndex) => <span key={noteIndex} className={cn("block text-xs", NOTE_TONE[note.tone])}>{note.message}</span>)}
                    </span>
                    <Chip tone={ROW_LABEL[row.kind].tone}>{ROW_LABEL[row.kind].label}</Chip>
                  </li>
                ))}
              </ul>
              )}
              {(review?.preview?.sourceChanges.length ?? 0) > 0 && (
                <ul className="list-disc border-t border-gray-200 py-2.5 pl-8 pr-4 text-xs text-amber-800">{review!.preview!.sourceChanges.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul>
              )}
              {(review?.preview?.changeSet.irreversible.length ?? 0) > 0 && (
                <div className="border-t border-gray-200 px-4 py-2.5 text-xs text-gray-600">
                  <p className="font-medium text-gray-900">Cannot be undone automatically</p>
                  <ul className="mt-1 list-disc pl-4">{review!.preview!.changeSet.irreversible.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul>
                </div>
              )}
            </div>
          )
        })}
        {secrets.needed && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={ack} disabled={planning} onChange={(event) => onAck(event.target.checked)} />
            <span>I understand that secrets in these policies are not synced and must be set again in each target.{ack && !secrets.acknowledged && planning ? " Planning again with this acknowledgement." : ""}</span>
          </label>
        )}
        {writes && <fieldset className="pt-2">
          <legend className="text-sm font-medium text-gray-800">Backup before changes</legend>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {option("new", "Back up first", "Each target runs a backup with its backup settings before anything else happens. It must include every policy type this sync changes. If the backup fails, nothing is changed.")}
            {option("none", "Skip the backup", "Rollback still works from the saved versions: TenuVault saves the current version of every policy it changes before writing. A rollback always backs up first, so it needs backup storage in the target tenant. Those saved versions are kept on this device only; without a backup they are the only copy.")}
          </div>
          {backup === "new" && targets.some((target) => !tenantOf(target.targetTenantId)?.resources?.storageAccountName) && (
            <p className="mt-2 text-xs text-gray-500">A tenant without backup storage cannot be backed up. <Link to={settingsHref("signin")} className="text-blue-700 underline">Choose backup storage in Settings</Link>.</p>
          )}
        </fieldset>}
      </div>
      <Footer>
        <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
        <span className="text-sm text-gray-500">{!writes ? "Nothing is written." : backup === "new" ? "Each target is backed up before anything is written." : "No backup is taken. Rollback uses the saved current versions."}</span>
        <Button type="button" disabled={busy || checking || gated || !(ready || inSync)} onClick={onApprove}>
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          {ready || !inSync ? `Approve and sync to ${plural(ready, "tenant", "tenants")}` : "Continue: nothing to write"}
        </Button>
      </Footer>
    </section>
  )
}

/** The plan running: what is being read, an indeterminate bar, and the seconds once it is slow. */
function PlanningPanel({ source, targets }: { source: string; targets: number }) {
  const elapsed = stillReading(useElapsed(true))
  return (
    <div role="status" className="sync-node rounded-2xl bg-gray-50 p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Spinner />
        <p className="text-sm font-medium text-gray-900">Reading {source} and {plural(targets, "target tenant", "target tenants")}</p>
        {elapsed && <span className="ml-auto text-xs tabular-nums text-gray-500">{elapsed}</span>}
      </div>
      <p className="mt-1.5 pl-[1.625rem] text-xs text-gray-500">The sync is planned from the live source policies, then each target is checked. Nothing is written.</p>
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-gray-200">
        <div className="run-indeterminate h-full w-1/3 rounded-full bg-coral-500" />
      </div>
    </div>
  )
}

/** A planned target while its live preview is read: what happens, the seconds once slow, and placeholder rows. */
function CheckingRows({ count }: { count: number }) {
  const elapsed = stillReading(useElapsed(true))
  return (
    <div role="status" className="border-t border-gray-200">
      <p className="flex items-center gap-2 px-4 py-2.5 text-xs text-gray-600">
        <Spinner />
        Checking against the live tenant{elapsed ? `. ${elapsed}` : ""}
      </p>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-4 border-t border-gray-200 px-4 py-3">
          <Skeleton className={cn("h-3.5 bg-gray-200", index % 2 ? "w-40" : "w-56")} />
          <Skeleton className="h-6 w-20 bg-gray-200" />
        </div>
      ))}
    </div>
  )
}
