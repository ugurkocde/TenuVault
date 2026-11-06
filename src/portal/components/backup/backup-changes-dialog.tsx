"use client"

import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { BellPlus, ChevronDown, ChevronRight, Loader2, Minus, PencilLine, Plus } from "lucide-react"
import { alertForPolicyHref } from "@desktop/lib/alert-links"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { cn } from "~/lib/utils"
import { formatDate, type BackupSummary, type BackupTenant } from "./types"

interface ChangedItem {
  folder: string
  id: string
  change: "added" | "modified" | "removed"
  name: string
  typeLabel: string
  fields?: Array<{ field: string; oldValue: unknown; newValue: unknown }>
}

interface BackupChangesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenant: BackupTenant
  backup: BackupSummary
  /** The backup it is compared with, for its date. */
  previous?: BackupSummary
}

const ICONS = { added: Plus, modified: PencilLine, removed: Minus }
const LABELS = { added: "Added", modified: "Changed", removed: "Deleted" }
const TONES = { added: "text-green-700 bg-green-50", modified: "text-amber-800 bg-amber-50", removed: "text-red-700 bg-red-50" }

const show = (value: unknown) => {
  if (value === undefined) return "not set"
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

/** Items added, changed and deleted in the tenant between the previous backup and this one. */
export function BackupChangesDialog({ open, onOpenChange, tenant, backup, previous }: BackupChangesDialogProps) {
  const [items, setItems] = useState<ChangedItem[] | null>(null)
  const [error, setError] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setItems(null)
    setError("")
    const controller = new AbortController()
    void fetch("/api/backup-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.storageAccountName, backupId: backup.id }),
    })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? "Changes could not be listed.")
        setItems(data.changes)
      })
      .catch((failure: unknown) => {
        if (failure instanceof DOMException && failure.name === "AbortError") return
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => controller.abort()
  }, [open, backup.id, tenant])

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Changes in this backup</DialogTitle>
          <DialogDescription>
            {formatDate(backup.timestamp)} compared with {previous ? formatDate(previous.timestamp) : "the previous backup"}. Only types both backups include are compared.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p>}
        {!items && !error && (
          <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Comparing backups...
          </div>
        )}
        {items && items.length === 0 && <p className="py-6 text-sm text-gray-600">Nothing changed between these backups.</p>}
        {items && items.length > 0 && (
          <ul className="divide-y divide-gray-100">
            {items.map((item) => {
              const key = `${item.folder}/${item.id}`
              const Icon = ICONS[item.change]
              const open = expanded.has(key)
              const expandable = item.change === "modified" && (item.fields?.length ?? 0) > 0
              return (
                <li key={key} className="py-3">
                  <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={cn("flex min-w-0 flex-1 items-center gap-3 text-left", !expandable && "cursor-default")}
                    onClick={() => expandable && toggle(key)}
                    aria-expanded={expandable ? open : undefined}
                  >
                    <span className={cn("flex size-7 flex-shrink-0 items-center justify-center rounded-full", TONES[item.change])} title={LABELS[item.change]}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900">{item.name}</span>
                      <span className="block text-xs text-gray-500">
                        {LABELS[item.change]}, {item.typeLabel}
                        {expandable && `, ${item.fields!.length} setting${item.fields!.length === 1 ? "" : "s"}`}
                      </span>
                    </span>
                    {expandable && (open ? <ChevronDown className="h-4 w-4 text-gray-500" /> : <ChevronRight className="h-4 w-4 text-gray-500" />)}
                  </button>
                  {item.change !== "removed" && (
                    <Link
                      to={alertForPolicyHref(item.name, item.folder)}
                      className="flex size-8 flex-shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
                      title={`Alert me about changes to ${item.name}`}
                      aria-label={`Alert me about changes to ${item.name}`}
                    >
                      <BellPlus className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  )}
                  </div>
                  {expandable && open && (
                    <dl className="mt-2 space-y-2 rounded-2xl bg-gray-50 p-3 pl-4 text-xs">
                      {item.fields!.map((field) => (
                        <div key={field.field}>
                          <dt className="font-mono text-gray-700 break-all">{field.field}</dt>
                          <dd className="mt-0.5 break-all text-gray-600">
                            <span className="text-red-700">{show(field.oldValue)}</span> {"->"} <span className="text-green-700">{show(field.newValue)}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
