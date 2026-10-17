import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, Eye, History, Plus, Search, Shield, Trash2, X } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip, Tile } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType, type NotificationSeverity } from "../../../shared/notifications/envelope"
import { toast } from "../../lib/toast"
import { UpgradeNote } from "../../components/UpgradeNote"
import {
  CHANNEL_KIND_LABELS,
  EVENT_TYPE_LABELS,
  formatTime,
  notificationsApi,
  type AuditWatch,
  type ChannelKind,
  type EmailRecipient,
  type NotificationRule,
  type PublicChannel,
} from "./api"

const SEVERITIES: NotificationSeverity[] = ["info", "warning", "critical"]
const INTERVALS = [5, 15, 30, 60, 240, 1440]
const failed = (error: unknown) => toast(error instanceof Error ? error.message : "The request failed.", "error")
const selectClass = "h-8 rounded-full border border-gray-200 bg-white px-3 text-sm dark:bg-input/30"

/**
 * Per tenant notification setup: channels (this computer, webhook, Teams, email), the
 * rules that route events to them, the Intune audit watch, and recent deliveries.
 * Channel URLs and secrets are write only: the stored value is never shown again.
 */
export function NotificationsPanel({ tenant }: { tenant: Tenant }) {
  const tenantId = tenant.credentials?.tenantId
  const client = useQueryClient()
  const status = useQuery({ queryKey: ["notifications-status", tenantId], queryFn: () => notificationsApi.status(tenant), enabled: !!tenantId })
  const refresh = () => void client.invalidateQueries({ queryKey: ["notifications-status", tenantId] })
  const data = status.data

  if (status.isLoading) return <p className="text-sm text-gray-500">Loading notification settings...</p>
  if (status.error) return <p className="text-sm text-red-700" role="alert">{status.error instanceof Error ? status.error.message : "Notification settings could not be loaded."}</p>
  if (!data) return null

  return (
    <div className="space-y-4">
      {!data.licensed && <UpgradeNote feature="notifications" />}
      <p className="text-sm text-gray-600" role="note">{data.runtimeNote}</p>
      <ChannelsTile tenant={tenant} channels={data.channels} licensed={data.licensed} onChanged={refresh} />
      <RulesTile tenant={tenant} rules={data.rules} channels={data.channels} licensed={data.licensed} onChanged={refresh} />
      <AuditWatchTile tenant={tenant} auditWatch={data.auditWatch} licensed={data.licensed} onChanged={refresh} />
      <Tile aria-labelledby="notifications-deliveries-heading" className="gap-3">
        <h3 id="notifications-deliveries-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
          <History className="h-4 w-4 text-gray-500" aria-hidden="true" />
          Recent deliveries
        </h3>
        {data.deliveries.length === 0 && <p className="text-sm text-gray-500">Nothing has been delivered yet. Send a test from a channel to see it here.</p>}
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {data.deliveries.map((delivery) => (
            <li key={delivery.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <Chip tone={delivery.state === "sent" ? "success" : delivery.state === "failed" ? "danger" : "warning"}>{delivery.state}</Chip>
              <span className="font-medium text-gray-900">{delivery.title}</span>
              <span className="text-gray-500">to {delivery.channelTitle} · {delivery.eventType} · {formatTime(delivery.at)}</span>
              {delivery.attempts > 1 && <span className="text-gray-500">{delivery.attempts} attempts</span>}
              {delivery.lastError && <span className="text-red-700" role="status">{delivery.lastError}</span>}
            </li>
          ))}
        </ul>
      </Tile>
    </div>
  )
}

function ChannelsTile({ tenant, channels, licensed, onChanged }: { tenant: Tenant; channels: PublicChannel[]; licensed: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const hasLocal = channels.some((channel) => channel.kind === "local")
  const addLocal = useMutation({ mutationFn: () => notificationsApi.addChannel(tenant, { kind: "local" }), onSuccess: () => { toast("Local notifications on", "success"); onChanged() }, onError: failed })
  const showPreview = useMutation({ mutationFn: (channelId: string) => notificationsApi.previewEvent(tenant, channelId), onSuccess: (result) => setPreview(result.body), onError: failed })

  return (
    <Tile aria-labelledby="notifications-channels-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="notifications-channels-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
            <Bell className="h-4 w-4 text-gray-500" aria-hidden="true" />
            Channels
          </h3>
          <p className="max-w-3xl text-sm text-gray-600">Where notifications go. A channel on its own sends nothing: add a rule below to route events to it. Payloads carry names, counts and statuses only, never policy content, tokens or credentials.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!hasLocal && <Button type="button" variant="outline" size="sm" disabled={!licensed || addLocal.isPending} onClick={() => addLocal.mutate()}>Notify on this computer</Button>}
          <Button type="button" variant="outline" size="sm" disabled={!licensed} onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden="true" />Add channel</Button>
        </div>
      </div>
      {channels.length === 0 && <p className="text-sm text-gray-500">No channels yet. Events are only shown inside TenuVault.</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {channels.map((channel) => (
          <ChannelRow key={channel.id} tenant={tenant} channel={channel} licensed={licensed} onChanged={onChanged} onPreview={() => showPreview.mutate(channel.id)} />
        ))}
      </ul>
      {adding && <AddChannelDialog tenant={tenant} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onChanged() }} />}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Event preview</DialogTitle>
            <DialogDescription>This is the test event envelope for this channel. Webhooks receive it as JSON, Teams as an Adaptive Card, email as a formatted message, built from these same fields.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto rounded-2xl bg-gray-50 p-4 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100" tabIndex={0}>{preview}</pre>
        </DialogContent>
      </Dialog>
    </Tile>
  )
}

function channelTarget(channel: PublicChannel): string {
  if (channel.kind === "local") return "System notification on this computer"
  if (channel.kind === "email") return channel.recipients.map((recipient) => (recipient.type === "address" ? recipient.address : recipient.displayName ?? `Group ${recipient.groupId}`)).join(", ")
  return channel.urlHost ?? CHANNEL_KIND_LABELS[channel.kind]
}

function ChannelRow({ tenant, channel, licensed, onChanged, onPreview }: { tenant: Tenant; channel: PublicChannel; licensed: boolean; onChanged: () => void; onPreview: () => void }) {
  const update = useMutation({ mutationFn: (enabled: boolean) => notificationsApi.updateChannel(tenant, channel.id, { enabled }), onSuccess: onChanged, onError: failed })
  const revoke = useMutation({ mutationFn: () => notificationsApi.revokeChannel(tenant, channel.id), onSuccess: () => { toast("Channel removed", "success"); onChanged() }, onError: failed })
  const test = useMutation({
    mutationFn: () => notificationsApi.testChannel(tenant, channel.id),
    onSuccess: (result) => { toast(result.delivery.ok ? "Test delivered" : `Test failed: ${result.delivery.error ?? "unknown error"}`, result.delivery.ok ? "success" : "error"); onChanged() },
    onError: failed,
  })
  const last = channel.lastDelivery
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={channel.enabled ? "success" : "neutral"}>{channel.enabled ? "On" : "Off"}</Chip>
        <span className="font-medium text-gray-900">{channel.title}</span>
        <Chip tone="neutral">{CHANNEL_KIND_LABELS[channel.kind]}</Chip>
        <span className="text-sm text-gray-500">{channelTarget(channel)}</span>
        {channel.hasSecret && <Chip tone="neutral">{channel.signRequests ? "Signing secret set" : `Secret header ${channel.headerName ?? ""} set`}</Chip>}
      </div>
      <p className={last && !last.ok ? "text-sm text-red-700" : "text-sm text-gray-600"} role={last && !last.ok ? "status" : undefined}>
        {last ? `${last.ok ? "Last delivery succeeded" : `Last delivery failed after ${last.attempts} attempts: ${last.error ?? "unknown error"}`} (${formatTime(last.at)}${last.test ? ", test" : ""})` : "Nothing delivered yet."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => update.mutate(!channel.enabled)} disabled={!licensed || update.isPending}>{channel.enabled ? "Turn off" : "Turn on"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => test.mutate()} disabled={!licensed || test.isPending}>{test.isPending ? "Sending" : "Send test"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onPreview}><Eye className="h-4 w-4" aria-hidden="true" />Preview event</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</Button>
      </div>
    </li>
  )
}

interface RecipientRow {
  type: "address" | "group"
  value: string
  displayName?: string | null
}

function buildRecipients(rows: RecipientRow[]): EmailRecipient[] {
  return rows
    .map((row) => ({ ...row, value: row.value.trim() }))
    .filter((row) => row.value)
    .map((row) => (row.type === "address" ? { type: "address" as const, address: row.value } : { type: "group" as const, groupId: row.value, displayName: row.displayName ?? null }))
}

function RecipientRows({ tenant, rows, onChange }: { tenant: Tenant; rows: RecipientRow[]; onChange: (rows: RecipientRow[]) => void }) {
  const [search, setSearch] = useState("")
  const lookup = useMutation({ mutationFn: () => notificationsApi.listGroups(tenant, search.trim()), onError: failed })
  const setRow = (index: number, patch: Partial<RecipientRow>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm text-gray-700">Recipients</legend>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <select className={selectClass} value={row.type} onChange={(event) => setRow(index, { type: event.target.value as RecipientRow["type"], displayName: null })} aria-label={`Recipient ${index + 1} kind`}>
            <option value="address">Email address</option>
            <option value="group">Group</option>
          </select>
          <Input
            className="min-w-48 flex-1"
            value={row.value}
            maxLength={320}
            placeholder={row.type === "address" ? "name@contoso.com" : "Entra group object ID (GUID)"}
            onChange={(event) => setRow(index, { value: event.target.value, displayName: null })}
            aria-label={`Recipient ${index + 1}`}
          />
          {row.displayName && <span className="text-sm text-gray-500">{row.displayName}</span>}
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, at) => at !== index))} disabled={rows.length === 1} aria-label={`Remove recipient ${index + 1}`}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...rows, { type: "address", value: "" }])}><Plus className="h-4 w-4" aria-hidden="true" />Add recipient</Button>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Input className="min-w-48 flex-1" value={search} maxLength={100} placeholder="Search groups by name" onChange={(event) => setSearch(event.target.value)} aria-label="Search groups by name" />
        <Button type="button" size="sm" variant="outline" disabled={!search.trim() || lookup.isPending} onClick={() => lookup.mutate()}><Search className="h-4 w-4" aria-hidden="true" />{lookup.isPending ? "Searching" : "Search groups"}</Button>
      </div>
      {lookup.data && (
        <ul className="space-y-1">
          {lookup.data.length === 0 && <li className="text-sm text-gray-500">No groups found. Paste the group object ID instead.</li>}
          {lookup.data.map((group) => (
            <li key={group.id}>
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...rows.filter((row) => row.value.trim()), { type: "group", value: group.id, displayName: group.displayName }])}>
                Add {group.displayName ?? group.id}{group.mail ? ` (${group.mail})` : ""}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-500">A group recipient mails its current members. You can also paste a group object ID from the Entra admin center without searching.</p>
    </fieldset>
  )
}

function AddChannelDialog({ tenant, onClose, onAdded }: { tenant: Tenant; onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<Exclude<ChannelKind, "local">>("webhook")
  const [title, setTitle] = useState("")
  const [url, setUrl] = useState("")
  const [headerName, setHeaderName] = useState("")
  const [headerValue, setHeaderValue] = useState("")
  const [signRequests, setSignRequests] = useState(false)
  const [rows, setRows] = useState<RecipientRow[]>([{ type: "address", value: "" }])
  const recipients = buildRecipients(rows)
  const headerPairIncomplete = kind === "webhook" && !signRequests && Boolean(headerName.trim()) !== Boolean(headerValue)
  const secretHint =
    kind !== "webhook"
      ? null
      : signRequests && !headerValue
        ? "Request signing needs a secret value."
        : !signRequests && headerValue && !headerName.trim()
          ? "Add a header name for this secret, or turn on request signing to use the value as the signing secret."
          : !signRequests && headerName.trim() && !headerValue
            ? "Add the secret value for this header, or clear the header name."
            : null
  const valid = kind === "email" ? recipients.length > 0 : Boolean(url.trim()) && (!signRequests || Boolean(headerValue)) && !headerPairIncomplete
  const add = useMutation({
    mutationFn: () =>
      notificationsApi.addChannel(tenant, {
        kind,
        title: title.trim() || undefined,
        ...(kind === "email"
          ? { recipients }
          : {
              url: url.trim(),
              ...(kind === "webhook" ? { headerName: headerName.trim() || undefined, headerValue: headerValue || undefined, signRequests } : {}),
            }),
      }),
    onSuccess: () => { toast("Channel added", "success"); onAdded() },
    onError: failed,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a channel</DialogTitle>
          <DialogDescription>Notifications carry names, counts, statuses and timestamps only. Addresses, URLs and secrets entered here stay on this computer and are never shown again in full.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (valid) add.mutate() }}>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Kind
            <select className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as Exclude<ChannelKind, "local">)}>
              <option value="webhook">Webhook (https POST)</option>
              <option value="teams">Teams channel (Workflows)</option>
              <option value="email">Email</option>
            </select>
          </label>
          <label className="block text-sm text-gray-700">Name (optional)<Input className="mt-1" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          {kind === "teams" && (
            <div className="space-y-1 rounded-2xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-gray-900">
              <p className="font-medium">Get a Teams Workflows URL</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>In Teams, open the channel menu (the three dots next to the channel name) and choose Workflows.</li>
                <li>Choose the template "Post to a channel when a webhook request is received".</li>
                <li>Name the flow, pick the team and channel, and create it.</li>
                <li>Copy the URL it shows and paste it below. Anyone with that URL can post to the channel, so treat it as a secret.</li>
              </ol>
            </div>
          )}
          {kind !== "email" && (
            <label className="block text-sm text-gray-700">
              {kind === "teams" ? "Workflows URL" : "https URL"}
              <Input className="mt-1" type="url" required maxLength={2000} placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} />
            </label>
          )}
          {kind === "webhook" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm text-gray-700">Secret header name (optional)<Input className="mt-1" maxLength={64} value={headerName} onChange={(event) => setHeaderName(event.target.value)} /></label>
                <label className="block text-sm text-gray-700">Secret value<Input className="mt-1" type="password" autoComplete="off" maxLength={2000} value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} /></label>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" className="size-4 accent-coral-600" checked={signRequests} onChange={(event) => setSignRequests(event.target.checked)} />
                Sign requests with the secret value (HMAC). Needs a secret value; the header name stays optional.
              </label>
              {secretHint && <p className="text-xs text-amber-700" role="status">{secretHint}</p>}
              <p className="text-xs text-gray-500">The secret value is stored on this computer, sent only to your endpoint, and never shown again.</p>
            </>
          )}
          {kind === "email" && (
            <>
              <RecipientRows tenant={tenant} rows={rows} onChange={setRows} />
              <p className="text-xs text-gray-500">Mail is sent through Microsoft Graph as the account you are signed in with for this tenant, and is not kept in Sent Items.</p>
            </>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={add.isPending || !valid}>{add.isPending ? "Adding" : "Add channel"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RulesTile({ tenant, rules, channels, licensed, onChanged }: { tenant: Tenant; rules: NotificationRule[]; channels: PublicChannel[]; licensed: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const channelTitle = (id: string) => channels.find((channel) => channel.id === id)?.title ?? "Removed channel"
  return (
    <Tile aria-labelledby="notifications-rules-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="notifications-rules-heading" className="text-lg font-medium text-gray-900">Rules</h3>
          <p className="max-w-3xl text-sm text-gray-600">A rule sends matching events, at or above its minimum severity, to its channels. Intune changes already arrive as one summary per poll.</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={!licensed || channels.length === 0} onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden="true" />Add rule</Button>
      </div>
      {channels.length === 0 && <p className="text-sm text-gray-500">Add a channel first, then route events to it with a rule.</p>}
      {channels.length > 0 && rules.length === 0 && <p className="text-sm text-gray-500">No rules yet. Channels stay quiet until a rule routes events to them.</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {rules.map((rule) => (
          <RuleRow key={rule.id} tenant={tenant} rule={rule} licensed={licensed} onChanged={onChanged} channelTitle={channelTitle} />
        ))}
      </ul>
      {adding && <AddRuleDialog tenant={tenant} channels={channels} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onChanged() }} />}
    </Tile>
  )
}

function RuleRow({ tenant, rule, licensed, onChanged, channelTitle }: { tenant: Tenant; rule: NotificationRule; licensed: boolean; onChanged: () => void; channelTitle: (id: string) => string }) {
  const update = useMutation({ mutationFn: (enabled: boolean) => notificationsApi.updateRule(tenant, rule.id, { enabled }), onSuccess: onChanged, onError: failed })
  const revoke = useMutation({ mutationFn: () => notificationsApi.revokeRule(tenant, rule.id), onSuccess: () => { toast("Rule removed", "success"); onChanged() }, onError: failed })
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "On" : "Off"}</Chip>
        <span className="font-medium text-gray-900">{rule.title}</span>
        <Chip tone={rule.minSeverity === "critical" ? "danger" : rule.minSeverity === "warning" ? "warning" : "neutral"}>{rule.minSeverity} and above</Chip>
        {rule.mode === "digest" && <span className="text-sm text-gray-500">Mode: digest</span>}
      </div>
      <p className="text-sm text-gray-600">{rule.eventTypes.map((type) => EVENT_TYPE_LABELS[type] ?? type).join(", ")}</p>
      <p className="text-sm text-gray-500">To: {rule.channelIds.map(channelTitle).join(", ") || "no channels"}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => update.mutate(!rule.enabled)} disabled={!licensed || update.isPending}>{rule.enabled ? "Turn off" : "Turn on"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</Button>
      </div>
    </li>
  )
}

/** Event types a new rule cannot pick: shown disabled so they never look functional. Stored rules that already contain them still render in RuleRow. */
const INERT_EVENT_TYPES: ReadonlySet<NotificationEventType> = new Set(["test", "watcher.stale"])

const EVENT_TYPE_NOTES: Partial<Record<NotificationEventType, string>> = {
  test: "Sent from a channel Send test button and bypasses rules",
  "watcher.stale": "No producer in the desktop app",
  "backup.missed": "Azure watcher only",
  "health.finding": "Configured on the Health review screen",
}

function AddRuleDialog({ tenant, channels, onClose, onAdded }: { tenant: Tenant; channels: PublicChannel[]; onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState("")
  const [eventTypes, setEventTypes] = useState<NotificationEventType[]>(["backup.failed"])
  const [minSeverity, setMinSeverity] = useState<NotificationSeverity>("info")
  const [channelIds, setChannelIds] = useState<string[]>(channels[0] ? [channels[0].id] : [])
  const valid = eventTypes.length > 0 && channelIds.length > 0
  const add = useMutation({
    mutationFn: () => notificationsApi.addRule(tenant, { title: title.trim() || undefined, eventTypes, minSeverity, channelIds, mode: "immediate" }),
    onSuccess: () => { toast("Rule added", "success"); onAdded() },
    onError: failed,
  })
  const toggleEvent = (type: NotificationEventType, checked: boolean) => setEventTypes((current) => (checked ? [...current, type] : current.filter((entry) => entry !== type)))
  const toggleChannel = (id: string, checked: boolean) => setChannelIds((current) => (checked ? [...current, id] : current.filter((entry) => entry !== id)))
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a rule</DialogTitle>
          <DialogDescription>Pick the events, the lowest severity that should send, and where they go.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid) add.mutate() }}>
          <label className="block text-sm text-gray-700">Name (optional)<Input className="mt-1" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <fieldset className="space-y-1.5">
            <legend className="text-sm text-gray-700">Event types</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {NOTIFICATION_EVENT_TYPES.map((type) => {
                const inert = INERT_EVENT_TYPES.has(type)
                const note = EVENT_TYPE_NOTES[type]
                return (
                  <label key={type} className={inert ? "flex items-center gap-2 text-sm text-gray-400" : "flex items-center gap-2 text-sm text-gray-700"}>
                    <input type="checkbox" className="size-4 accent-coral-600" disabled={inert} checked={!inert && eventTypes.includes(type)} onChange={(event) => toggleEvent(type, event.target.checked)} />
                    <span>
                      {EVENT_TYPE_LABELS[type]}
                      {note && <span className="text-gray-500"> ({note})</span>}
                    </span>
                  </label>
                )
              })}
            </div>
            <p className="text-xs text-gray-500">Test notifications are sent from a channel Send test button and bypass rules. Watcher stale has no producer in the desktop app, so neither can be picked here.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-gray-700">
              Minimum severity
              <select className={selectClass} value={minSeverity} onChange={(event) => setMinSeverity(event.target.value as NotificationSeverity)}>
                {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm text-gray-700">Send to</legend>
            {channels.map((channel) => (
              <label key={channel.id} className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" className="size-4 accent-coral-600" checked={channelIds.includes(channel.id)} onChange={(event) => toggleChannel(channel.id, event.target.checked)} />
                {channel.title} <span className="text-gray-500">({CHANNEL_KIND_LABELS[channel.kind]})</span>
              </label>
            ))}
          </fieldset>
          {!valid && <p className="text-sm text-gray-500">Pick at least one event type and one channel.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={add.isPending || !valid}>{add.isPending ? "Adding" : "Add rule"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AuditWatchTile({ tenant, auditWatch, licensed, onChanged }: { tenant: Tenant; auditWatch: AuditWatch | null; licensed: boolean; onChanged: () => void }) {
  const [enabled, setEnabled] = useState(false)
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [categories, setCategories] = useState("")
  const [ignoreOwnChanges, setIgnoreOwnChanges] = useState(true)
  const [includeActor, setIncludeActor] = useState(false)
  const [externalWatcher, setExternalWatcher] = useState(false)

  useEffect(() => {
    setEnabled(auditWatch?.enabled ?? false)
    setIntervalMinutes(auditWatch?.intervalMinutes ?? 60)
    setCategories((auditWatch?.categories ?? []).join(", "))
    setIgnoreOwnChanges(auditWatch?.ignoreOwnChanges ?? true)
    setIncludeActor(auditWatch?.includeActor ?? false)
    setExternalWatcher(auditWatch?.externalWatcher ?? false)
  }, [auditWatch])

  const save = useMutation({
    mutationFn: () =>
      notificationsApi.updateAuditWatch(tenant, {
        enabled,
        intervalMinutes,
        categories: categories.split(",").map((entry) => entry.trim()).filter(Boolean),
        ignoreOwnChanges,
        includeActor,
        externalWatcher,
      }),
    onSuccess: () => { toast("Change watching saved", "success"); onChanged() },
    onError: failed,
  })
  const poll = useMutation({
    mutationFn: () => notificationsApi.runAuditWatch(tenant),
    onSuccess: (result) => {
      if (result.error) toast(`Poll failed: ${result.error}`, "error")
      else toast(result.changes > 0 ? `${result.changes} change${result.changes === 1 ? "" : "s"} found, ${result.enqueued} queued for delivery.` : "No new changes found.", "success")
      onChanged()
    },
    onError: failed,
  })

  return (
    <Tile aria-labelledby="notifications-audit-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="notifications-audit-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
            <Shield className="h-4 w-4 text-gray-500" aria-hidden="true" />
            Intune change watching
          </h3>
          <p className="max-w-3xl text-sm text-gray-600">Polls the Intune audit log and sends one digest of what changed through your rules for the "Intune change" event type. Only policy names, change types and times are read. Audit request bodies and setting values are never read or sent.</p>
        </div>
        <Chip tone={auditWatch?.enabled ? "success" : "neutral"}>{auditWatch?.enabled ? "Watching" : "Off"}</Chip>
      </div>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" className="size-4 accent-coral-600" checked={enabled} disabled={!licensed} onChange={(event) => setEnabled(event.target.checked)} />
          Watch for Intune changes while TenuVault is running
        </label>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" className="size-4 accent-coral-600" checked={externalWatcher} disabled={!licensed} onChange={(event) => setExternalWatcher(event.target.checked)} />
            An Azure watcher owns change alerts for this tenant
          </label>
          <p className="text-xs text-gray-500">With this on, desktop polling stands down for this tenant so each change is reported once, by the Azure watcher.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2 text-gray-700">
            Check every
            <select className={selectClass} value={intervalMinutes} disabled={!licensed} onChange={(event) => setIntervalMinutes(Number(event.target.value))}>
              {INTERVALS.map((minutes) => (
                <option key={minutes} value={minutes}>{minutes >= 60 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-gray-700">
            <input type="checkbox" className="size-4 accent-coral-600" checked={ignoreOwnChanges} disabled={!licensed} onChange={(event) => setIgnoreOwnChanges(event.target.checked)} />
            Ignore changes made by TenuVault itself
          </label>
          <label className="flex items-center gap-2 text-gray-700">
            <input type="checkbox" className="size-4 accent-coral-600" checked={includeActor} disabled={!licensed} onChange={(event) => setIncludeActor(event.target.checked)} />
            Include who made each change (actor UPN)
          </label>
        </div>
        <p className="text-xs text-gray-500">Actor names are personal data and are off by default. Leave this off for destinations outside Microsoft 365, such as generic webhooks or external email addresses.</p>
        <label className="block text-sm text-gray-700">
          Audit categories (optional, comma separated; empty means all)
          <Input className="mt-1" value={categories} disabled={!licensed} maxLength={1000} placeholder="For example: Policy, Compliance" onChange={(event) => setCategories(event.target.value)} />
        </label>
        <p className="text-sm text-gray-600">
          Last poll: {formatTime(auditWatch?.lastPollAt)}
          {auditWatch?.watermark ? ` · Watermark: ${formatTime(auditWatch.watermark)}` : ""}
        </p>
        {auditWatch?.lastError && <p className="text-sm text-red-700" role="status">Last poll error: {auditWatch.lastError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={!licensed || save.isPending}>{save.isPending ? "Saving" : "Save change watching"}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => poll.mutate()} disabled={!licensed || poll.isPending}>{poll.isPending ? "Polling" : "Poll now"}</Button>
        </div>
      </form>
    </Tile>
  )
}
