import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Tenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { Chip } from "~/components/dashboard/tiles"
import { toast } from "../../lib/toast"
import { createCustomization, listCustomizations, retireCustomization, reviseCustomization } from "./api"

const card = "space-y-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_rgba(22,21,20,0.04)]"
const input = "h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
const EMPTY = { title: "", settingKey: "", policyName: "", value: "", reason: "", owner: "" }

/**
 * The organization's documented deviations from its installed baseline (Pro): what differs,
 * why, who owns it, versioned with history. Baseline upgrades mark kept tenant settings that
 * are documented here. Without the plan the stored records stay readable.
 */
export function CustomizationsPanel({ tenant, allowed }: { tenant: Tenant; allowed: boolean }) {
  const tenantId = tenant.credentials?.tenantId
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  // Electron has no native text prompt; owner changes and retirements are entered inline.
  const [editing, setEditing] = useState<{ id: string; mode: "owner" | "retire"; text: string } | null>(null)
  const list = useQuery({ queryKey: ["customizations", tenantId], queryFn: () => listCustomizations(tenant), enabled: !!tenantId })
  const records = list.data?.customizations ?? []
  if (!allowed && !records.length) return null
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      toast(success, "success")
    } catch (error) {
      toast(error instanceof Error ? error.message : "The request failed.", "error")
    } finally {
      setBusy(false)
      void list.refetch()
    }
  }
  const field = (key: keyof typeof EMPTY, label: string, placeholder = "") => (
    <label className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
      <span>{label}</span>
      <input className={input} value={form[key]} placeholder={placeholder} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </label>
  )

  return (
    <section aria-label="Organization customizations" className={card}>
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{allowed ? "Organization customizations" : "Stored customizations (read-only)"}</h3>
        <p className="max-w-3xl text-sm text-gray-500">Document where this tenant deliberately differs from its installed baseline. Records are versioned; nothing here changes the tenant.</p>
      </div>
      {allowed && (
        <form className="grid gap-3 md:grid-cols-3" onSubmit={(event) => { event.preventDefault(); void run(async () => { await createCustomization(tenant, form); setForm(EMPTY) }, "Customization documented.") }}>
          {field("title", "Title", "Camera allowed on kiosks")}
          {field("settingKey", "Setting definition ID")}
          {field("policyName", "Policy name (optional)")}
          {field("value", "Organization value (optional)")}
          {field("reason", "Reason")}
          {field("owner", "Owner")}
          <div className="md:col-span-3"><Button type="submit" disabled={busy || !form.title || !form.settingKey || !form.reason || !form.owner}>Document customization</Button></div>
        </form>
      )}
      {list.data && !records.length && <p className="text-sm text-gray-600">No customizations documented yet.</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {records.map((record) => (
          <li key={record.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block text-gray-900 dark:text-gray-100">{record.title}</span>
              <span className="block break-all text-xs text-gray-500">{record.settingKey}{record.value ? ` = ${record.value}` : ""}. {record.reason} Owner: {record.owner}. Version {record.version}.</span>
            </span>
            <Chip tone={record.status === "active" ? "coral" : "neutral"}>{record.status}</Chip>
            {allowed && record.status === "active" && editing?.id !== record.id && (
              <>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing({ id: record.id, mode: "owner", text: record.owner })}>Change owner</Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing({ id: record.id, mode: "retire", text: "" })}>Retire</Button>
              </>
            )}
            {allowed && editing?.id === record.id && (
              <form className="flex w-full flex-wrap items-center gap-2" onSubmit={(event) => {
                event.preventDefault()
                const text = editing.text.trim()
                if (!text) return
                void run(() => (editing.mode === "owner" ? reviseCustomization(tenant, record.id, { owner: text, why: "Owner changed" }) : retireCustomization(tenant, record.id, text)), editing.mode === "owner" ? "New version saved." : "Customization retired.").then(() => setEditing(null))
              }}>
                <input aria-label={editing.mode === "owner" ? "New owner" : "Why it is retired"} className={`${input} max-w-sm`} value={editing.text} placeholder={editing.mode === "owner" ? "New owner" : "Why it is retired"} onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
                <Button type="submit" size="sm" disabled={busy || !editing.text.trim()}>Save</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
