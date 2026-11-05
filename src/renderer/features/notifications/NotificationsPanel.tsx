import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bell, Eye, History, Pencil, Plus, Search, Shield, Trash2, X } from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip, Tile } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType, type NotificationSeverity } from "../../../shared/notifications/envelope"
import { toast } from "../../lib/toast"
import { UpgradeNote } from "../../components/UpgradeNote"
import { TeamsCardTile } from "./CardLayoutEditor"
import {
  categoryLabel,
  CHANNEL_KIND_LABELS,
  EVENT_TYPE_LABELS,
  formatTime,
  notificationsApi,
  type AuditWatch,
  type ChannelKind,
  type EmailRecipient,
  type NotificationRule,
  type PublicChannel,
  type UpdateChannelBody,
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
export function NotificationsPanel({ tenant, active = true }: { tenant: Tenant; active?: boolean }) {
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
      <ChannelsTile tenant={tenant} channels={data.channels} rules={data.rules} licensed={data.licensed} active={active} onChanged={refresh} />
      <TeamsCardTile tenant={tenant} channels={data.channels} licensed={data.licensed} active={active} />
      <RulesTile tenant={tenant} rules={data.rules} channels={data.channels} licensed={data.licensed} active={active} onChanged={refresh} />
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

function ChannelsTile({ tenant, channels, rules, licensed, active, onChanged }: { tenant: Tenant; channels: PublicChannel[]; rules: NotificationRule[]; licensed: boolean; active: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<PublicChannel | null>(null)
  const [removing, setRemoving] = useState<PublicChannel | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const hasLocal = channels.some((channel) => channel.kind === "local")
  const addLocal = useMutation({ mutationFn: () => notificationsApi.addChannel(tenant, { kind: "local" }), onSuccess: () => { toast("Local notifications on", "success"); onChanged() }, onError: failed })
  const showPreview = useMutation({ mutationFn: (channelId: string) => notificationsApi.previewEvent(tenant, channelId), onSuccess: (result) => setPreview(result.body), onError: failed })
  const rulesUsing = (channel: PublicChannel) => rules.filter((rule) => rule.channelIds.includes(channel.id))

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
          <ChannelRow
            key={channel.id}
            tenant={tenant}
            channel={channel}
            licensed={licensed}
            ruleCount={rulesUsing(channel).length}
            onChanged={onChanged}
            onEdit={() => setEditing(channel)}
            onRemove={() => setRemoving(channel)}
            onPreview={() => showPreview.mutate(channel.id)}
          />
        ))}
      </ul>
      {adding && <ChannelDialog tenant={tenant} open={active} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged() }} />}
      {editing && <ChannelDialog tenant={tenant} channel={editing} open={active} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} />}
      {removing && <RemoveChannelDialog tenant={tenant} channel={removing} rules={rulesUsing(removing)} liveChannelIds={new Set(channels.map((channel) => channel.id))} open={active} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); onChanged() }} />}
      <Dialog open={active && preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
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

function ChannelRow({ tenant, channel, licensed, ruleCount, onChanged, onEdit, onRemove, onPreview }: { tenant: Tenant; channel: PublicChannel; licensed: boolean; ruleCount: number; onChanged: () => void; onEdit: () => void; onRemove: () => void; onPreview: () => void }) {
  const update = useMutation({
    // Turning off after a downgrade uses the free revoke action; turning on stays licensed.
    mutationFn: (enabled: boolean) => (!enabled && !licensed ? notificationsApi.revokeDisableChannel(tenant, channel.id) : notificationsApi.updateChannel(tenant, channel.id, { enabled })),
    onSuccess: onChanged,
    onError: failed,
  })
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
        <span className="text-sm text-gray-500">{ruleCount === 0 ? "Used by no rule" : `Used by ${ruleCount} rule${ruleCount === 1 ? "" : "s"}`}</span>
      </div>
      <p className={last && !last.ok ? "text-sm text-red-700" : "text-sm text-gray-600"} role={last && !last.ok ? "status" : undefined}>
        {last ? `${last.ok ? "Last delivery succeeded" : `Last delivery failed after ${last.attempts} attempts: ${last.error ?? "unknown error"}`} (${formatTime(last.at)}${last.test ? ", test" : ""})` : "Nothing delivered yet."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => update.mutate(!channel.enabled)} disabled={update.isPending || (!licensed && !channel.enabled)}>{channel.enabled ? "Turn off" : "Turn on"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onEdit} disabled={!licensed}><Pencil className="h-4 w-4" aria-hidden="true" />Edit</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => test.mutate()} disabled={!licensed || test.isPending}>{test.isPending ? "Sending" : "Send test"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onPreview}><Eye className="h-4 w-4" aria-hidden="true" />Preview event</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => (ruleCount > 0 ? onRemove() : revoke.mutate())} disabled={revoke.isPending}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</Button>
      </div>
    </li>
  )
}

/** Confirms removing a channel that rules still send to, and takes it out of those rules. */
function RemoveChannelDialog({ tenant, channel, rules, liveChannelIds, open, onClose, onRemoved }: { tenant: Tenant; channel: PublicChannel; rules: NotificationRule[]; liveChannelIds: Set<string>; open: boolean; onClose: () => void; onRemoved: () => void }) {
  const remove = useMutation({
    mutationFn: () => notificationsApi.revokeChannel(tenant, channel.id, { removeFromRules: true }),
    onSuccess: () => { toast("Channel removed", "success"); onRemoved() },
    onError: failed,
  })
  // The server turns off rules left without a live channel; say so before it happens.
  const emptied = rules.filter((rule) => !rule.channelIds.some((id) => id !== channel.id && liveChannelIds.has(id)))
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {channel.title}?</DialogTitle>
          <DialogDescription>
            {rules.length === 1 ? "1 rule sends" : `${rules.length} rules send`} to this channel. Removing it also takes it out of {rules.length === 1 ? "that rule" : "those rules"}. To send to a new URL instead, use Edit and keep the rules as they are.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-sm">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-900">{rule.title}</span>
              {emptied.includes(rule) && <Chip tone="warning">Turned off: no channel left</Chip>}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>{remove.isPending ? "Removing" : "Remove channel"}</Button>
        </div>
      </DialogContent>
    </Dialog>
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

function ChannelDialog({ tenant, channel, open, onClose, onSaved }: { tenant: Tenant; channel?: PublicChannel; open: boolean; onClose: () => void; onSaved: () => void }) {
  const editing = Boolean(channel)
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "webhook")
  const [title, setTitle] = useState(channel?.title ?? "")
  const [url, setUrl] = useState("")
  const [headerName, setHeaderName] = useState(channel?.headerName ?? "")
  const [headerValue, setHeaderValue] = useState("")
  const [clearSecret, setClearSecret] = useState(false)
  const [signRequests, setSignRequests] = useState(channel?.signRequests ?? false)
  const [rows, setRows] = useState<RecipientRow[]>(
    channel?.recipients.length
      ? channel.recipients.map((recipient) => (recipient.type === "address" ? { type: "address", value: recipient.address } : { type: "group", value: recipient.groupId, displayName: recipient.displayName ?? null }))
      : [{ type: "address", value: "" }],
  )
  const recipients = buildRecipients(rows)
  // On edit, a stored secret counts unless it is being removed; the value itself is never shown.
  const keptSecret = Boolean(channel?.hasSecret) && !clearSecret
  const hasSecretValue = Boolean(headerValue) || keptSecret
  const headerPairIncomplete = kind === "webhook" && !clearSecret && !signRequests && Boolean(headerName.trim()) !== hasSecretValue
  const secretHint =
    kind !== "webhook" || clearSecret
      ? null
      : signRequests && !hasSecretValue
        ? "Request signing needs a secret value."
        : !signRequests && hasSecretValue && !headerName.trim()
          ? "Add a header name for this secret, or turn on request signing to use the value as the signing secret."
          : !signRequests && headerName.trim() && !hasSecretValue
            ? "Add the secret value for this header, or clear the header name."
            : null
  const needsUrl = (kind === "webhook" || kind === "teams") && !editing
  const valid = kind === "email" ? recipients.length > 0 : kind === "local" ? true : (!needsUrl || Boolean(url.trim())) && (!signRequests || hasSecretValue) && !headerPairIncomplete
  const save = useMutation({
    mutationFn: () => {
      if (!channel) {
        return notificationsApi.addChannel(tenant, {
          kind,
          title: title.trim() || undefined,
          ...(kind === "email"
            ? { recipients }
            : {
                url: url.trim(),
                ...(kind === "webhook" ? { headerName: headerName.trim() || undefined, headerValue: headerValue || undefined, signRequests } : {}),
              }),
        })
      }
      const body: UpdateChannelBody = {}
      if (title.trim() && title.trim() !== channel.title) body.title = title.trim()
      if (url.trim()) body.url = url.trim()
      if (kind === "webhook") {
        if (clearSecret) body.clearSecret = true
        else {
          if (headerName.trim() !== (channel.headerName ?? "")) body.headerName = headerName.trim()
          if (headerValue) body.headerValue = headerValue
          if (signRequests !== channel.signRequests) body.signRequests = signRequests
        }
      }
      if (kind === "email") body.recipients = recipients
      return notificationsApi.updateChannel(tenant, channel.id, body)
    },
    onSuccess: () => { toast(editing ? "Channel saved" : "Channel added", "success"); onSaved() },
    onError: failed,
  })
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${channel!.title}` : "Add a channel"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "URLs and secrets are never shown again. Leave those fields empty to keep what is stored. Rules that send to this channel keep working, and queued deliveries go to the new address."
              : "Notifications carry names, counts, statuses and timestamps only. Addresses, URLs and secrets entered here stay on this computer and are never shown again in full."}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (valid) save.mutate() }}>
          {editing ? (
            <p className="text-sm text-gray-700">Kind <Chip tone="neutral">{CHANNEL_KIND_LABELS[kind]}</Chip></p>
          ) : (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              Kind
              <select className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as ChannelKind)}>
                <option value="webhook">Webhook (https POST)</option>
                <option value="teams">Teams channel (Workflows)</option>
                <option value="email">Email</option>
              </select>
            </label>
          )}
          <label className="block text-sm text-gray-700">Name{editing ? "" : " (optional)"}<Input className="mt-1" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          {kind === "teams" && !editing && (
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
          {(kind === "webhook" || kind === "teams") && (
            <label className="block text-sm text-gray-700">
              {kind === "teams" ? "Workflows URL" : "https URL"}
              <Input className="mt-1" type="url" required={!editing} maxLength={2000} placeholder={editing ? `Leave empty to keep the current URL (${channel?.urlHost ?? "stored"})` : "https://"} value={url} onChange={(event) => setUrl(event.target.value)} />
              {editing && kind === "teams" && <span className="mt-1 block text-xs text-gray-500">Paste a new Workflows URL when the old workflow was deleted or its owner left.</span>}
            </label>
          )}
          {kind === "webhook" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm text-gray-700">Secret header name (optional)<Input className="mt-1" maxLength={64} value={headerName} disabled={clearSecret} onChange={(event) => setHeaderName(event.target.value)} /></label>
                <label className="block text-sm text-gray-700">Secret value<Input className="mt-1" type="password" autoComplete="off" maxLength={2000} value={headerValue} disabled={clearSecret} placeholder={channel?.hasSecret ? "Leave empty to keep the current secret" : undefined} onChange={(event) => setHeaderValue(event.target.value)} /></label>
              </div>
              {channel?.hasSecret && (
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="size-4 accent-coral-600" checked={clearSecret} onChange={(event) => { setClearSecret(event.target.checked); if (event.target.checked) setSignRequests(false) }} />
                  Remove the stored secret (also turns request signing off)
                </label>
              )}
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" className="size-4 accent-coral-600" checked={signRequests} disabled={clearSecret} onChange={(event) => setSignRequests(event.target.checked)} />
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
            <Button type="submit" disabled={save.isPending || !valid}>{save.isPending ? "Saving" : editing ? "Save channel" : "Add channel"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RulesTile({ tenant, rules, channels, licensed, active, onChanged }: { tenant: Tenant; rules: NotificationRule[]; channels: PublicChannel[]; licensed: boolean; active: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<NotificationRule | null>(null)
  const known = new Set(channels.map((channel) => channel.id))
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
          <RuleRow key={rule.id} tenant={tenant} rule={rule} licensed={licensed} onChanged={onChanged} onEdit={() => setEditing(rule)} channelTitle={channelTitle} removedChannels={rule.channelIds.filter((id) => !known.has(id)).length} />
        ))}
      </ul>
      {adding && <RuleDialog tenant={tenant} channels={channels} open={active} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged() }} />}
      {editing && <RuleDialog tenant={tenant} channels={channels} rule={editing} open={active} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} />}
    </Tile>
  )
}

function RuleRow({ tenant, rule, licensed, onChanged, onEdit, channelTitle, removedChannels }: { tenant: Tenant; rule: NotificationRule; licensed: boolean; onChanged: () => void; onEdit: () => void; channelTitle: (id: string) => string; removedChannels: number }) {
  const update = useMutation({ mutationFn: (enabled: boolean) => notificationsApi.updateRule(tenant, rule.id, { enabled }), onSuccess: onChanged, onError: failed })
  const revoke = useMutation({ mutationFn: () => notificationsApi.revokeRule(tenant, rule.id), onSuccess: () => { toast("Rule removed", "success"); onChanged() }, onError: failed })
  const liveChannels = rule.channelIds.length - removedChannels
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "On" : "Off"}</Chip>
        <span className="font-medium text-gray-900">{rule.title}</span>
        <Chip tone={rule.minSeverity === "critical" ? "danger" : rule.minSeverity === "warning" ? "warning" : "neutral"}>{rule.minSeverity} and above</Chip>
        {removedChannels > 0 && <Chip tone="warning">{removedChannels} removed channel{removedChannels === 1 ? "" : "s"}</Chip>}
        {liveChannels === 0 && <Chip tone="danger">Sends nowhere</Chip>}
      </div>
      <p className="text-sm text-gray-600">{rule.eventTypes.map((type) => EVENT_TYPE_LABELS[type] ?? type).join(", ")}</p>
      <p className="text-sm text-gray-500">To: {rule.channelIds.map(channelTitle).join(", ") || "no channels"}</p>
      {(removedChannels > 0 || liveChannels === 0) && <p className="text-xs text-amber-700" role="status">Edit the rule to pick a channel. Removed channels are dropped when you save.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => update.mutate(!rule.enabled)} disabled={!licensed || update.isPending}>{rule.enabled ? "Turn off" : "Turn on"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onEdit} disabled={!licensed}><Pencil className="h-4 w-4" aria-hidden="true" />Edit</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</Button>
      </div>
    </li>
  )
}

/** Event types a new rule cannot pick: shown disabled so they never look functional. Stored rules that already contain them still render in RuleRow. */
const INERT_EVENT_TYPES: ReadonlySet<NotificationEventType> = new Set(["test", "health.finding"])

const EVENT_TYPE_NOTES: Partial<Record<NotificationEventType, string>> = {
  test: "Sent from a channel Send test button and bypasses rules",
  "watcher.stale": "While an Azure watcher owns change alerts",
  "backup.missed": "A slot missed while TenuVault was closed",
  "health.finding": "Configured on the Health review screen",
}

function RuleDialog({ tenant, channels, rule, open, onClose, onSaved }: { tenant: Tenant; channels: PublicChannel[]; rule?: NotificationRule; open: boolean; onClose: () => void; onSaved: () => void }) {
  const editing = Boolean(rule)
  const known = new Set(channels.map((channel) => channel.id))
  // Types a rule can no longer pick stay on the rule untouched when it is edited.
  const keptInert = (rule?.eventTypes ?? []).filter((type) => INERT_EVENT_TYPES.has(type))
  const [title, setTitle] = useState(rule?.title ?? "")
  const [eventTypes, setEventTypes] = useState<NotificationEventType[]>(rule ? rule.eventTypes.filter((type) => !INERT_EVENT_TYPES.has(type)) : ["backup.failed"])
  const [minSeverity, setMinSeverity] = useState<NotificationSeverity>(rule?.minSeverity ?? "info")
  const [channelIds, setChannelIds] = useState<string[]>(rule ? rule.channelIds.filter((id) => known.has(id)) : channels[0] ? [channels[0].id] : [])
  const valid = eventTypes.length + keptInert.length > 0 && channelIds.length > 0
  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim() || undefined, eventTypes: [...eventTypes, ...keptInert], minSeverity, channelIds }
      return rule ? notificationsApi.updateRule(tenant, rule.id, body) : notificationsApi.addRule(tenant, { ...body, mode: "immediate" })
    },
    onSuccess: () => { toast(editing ? "Rule saved" : "Rule added", "success"); onSaved() },
    onError: failed,
  })
  const toggleEvent = (type: NotificationEventType, checked: boolean) => setEventTypes((current) => (checked ? [...current, type] : current.filter((entry) => entry !== type)))
  const toggleChannel = (id: string, checked: boolean) => setChannelIds((current) => (checked ? [...current, id] : current.filter((entry) => entry !== id)))
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${rule!.title}` : "Add a rule"}</DialogTitle>
          <DialogDescription>Pick the events, the lowest severity that should send, and where they go.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid) save.mutate() }}>
          <label className="block text-sm text-gray-700">Name{editing ? "" : " (optional)"}<Input className="mt-1" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <fieldset className="space-y-1.5">
            <legend className="text-sm text-gray-700">Event types</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {NOTIFICATION_EVENT_TYPES.map((type) => {
                const inert = INERT_EVENT_TYPES.has(type)
                const note = EVENT_TYPE_NOTES[type]
                const kept = keptInert.includes(type)
                return (
                  <label key={type} className={inert ? "flex items-center gap-2 text-sm text-gray-400" : "flex items-center gap-2 text-sm text-gray-700"}>
                    <input type="checkbox" className="size-4 accent-coral-600" disabled={inert} checked={kept || (!inert && eventTypes.includes(type))} onChange={(event) => toggleEvent(type, event.target.checked)} />
                    <span>
                      {EVENT_TYPE_LABELS[type]}
                      {note && <span className="text-gray-500"> ({note})</span>}
                    </span>
                  </label>
                )
              })}
            </div>
            <p className="text-xs text-gray-500">Greyed out types cannot be picked. Test notifications bypass rules, and health findings are configured on the Health review screen. A rule that already contains one of these types keeps it.</p>
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
            {rule && rule.channelIds.some((id) => !known.has(id)) && <p className="text-xs text-amber-700">Removed channels are dropped from this rule when you save.</p>}
          </fieldset>
          {!valid && <p className="text-sm text-gray-500">Pick at least one event type and one channel.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || !valid}>{save.isPending ? "Saving" : editing ? "Save rule" : "Add rule"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const SKIPPED_POLL = {
  off: "Change watching is off. Turn it on and save before polling.",
  external: "An Azure watcher owns change alerts for this tenant, so this computer does not poll.",
  busy: "A poll is already running. Try again in a moment.",
} as const

function AuditWatchTile({ tenant, auditWatch, licensed, onChanged }: { tenant: Tenant; auditWatch: AuditWatch | null; licensed: boolean; onChanged: () => void }) {
  const [enabled, setEnabled] = useState(false)
  const [caEnabled, setCaEnabled] = useState(false)
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [categories, setCategories] = useState<string[]>([])
  const [ignoreOwnChanges, setIgnoreOwnChanges] = useState(true)
  const [includeActor, setIncludeActor] = useState(false)
  const [externalWatcher, setExternalWatcher] = useState(false)

  // Reset the form only when the stored settings change. A poll refreshes lastPollAt and
  // the watermark, which must not discard unsaved edits.
  const stored = JSON.stringify({
    enabled: auditWatch?.enabled ?? false,
    caEnabled: auditWatch?.conditionalAccess?.enabled ?? false,
    intervalMinutes: auditWatch?.intervalMinutes ?? 60,
    categories: auditWatch?.categories ?? [],
    ignoreOwnChanges: auditWatch?.ignoreOwnChanges ?? true,
    includeActor: auditWatch?.includeActor ?? false,
    externalWatcher: auditWatch?.externalWatcher ?? false,
  })
  useEffect(() => {
    const next = JSON.parse(stored) as { enabled: boolean; caEnabled: boolean; intervalMinutes: number; categories: string[]; ignoreOwnChanges: boolean; includeActor: boolean; externalWatcher: boolean }
    setEnabled(next.enabled)
    setCaEnabled(next.caEnabled)
    setIntervalMinutes(next.intervalMinutes)
    setCategories(next.categories)
    setIgnoreOwnChanges(next.ignoreOwnChanges)
    setIncludeActor(next.includeActor)
    setExternalWatcher(next.externalWatcher)
  }, [stored])

  const savedOn = Boolean(auditWatch?.enabled || auditWatch?.conditionalAccess?.enabled)
  // Without entitlement the only save allowed is turning watching off, through the free revoke action.
  const turningOff = !licensed && savedOn && !enabled && !caEnabled
  const save = useMutation({
    mutationFn: () =>
      !licensed
        ? notificationsApi.revokeAuditWatch(tenant)
        : notificationsApi.updateAuditWatch(tenant, { enabled, conditionalAccessEnabled: caEnabled, intervalMinutes, categories, ignoreOwnChanges, includeActor, externalWatcher }),
    onSuccess: () => { toast("Change watching saved", "success"); onChanged() },
    onError: failed,
  })
  // Poll now reads the saved settings, so it waits for watching to be saved on and owned by this computer.
  const pollBlocked = !savedOn ? SKIPPED_POLL.off : auditWatch?.externalWatcher ? SKIPPED_POLL.external : null
  const poll = useMutation({
    mutationFn: () => notificationsApi.runAuditWatch(tenant),
    onSuccess: (result) => {
      if (result.skipped) toast(SKIPPED_POLL[result.skipped], "info")
      else if (result.error) toast(`Poll failed: ${result.error}`, "error")
      else toast(result.changes > 0 ? `${result.changes} change${result.changes === 1 ? "" : "s"} found, ${result.enqueued} queued for delivery.` : "No new changes found.", "success")
      onChanged()
    },
    onError: failed,
  })
  const checkWatcher = useMutation({
    mutationFn: () => notificationsApi.runWatcherCheck(tenant),
    onSuccess: (result) => {
      if (result.error) toast(`The watcher heartbeat could not be read: ${result.error}`, "error")
      else toast(result.stale ? "The Azure watcher has not run recently." : "The Azure watcher ran recently.", result.stale ? "error" : "success")
      onChanged()
    },
    onError: failed,
  })
  const watching = [auditWatch?.enabled ? "Intune" : null, auditWatch?.conditionalAccess?.enabled ? "Conditional Access" : null].filter(Boolean)
  const check = auditWatch?.watcherCheck

  return (
    <Tile aria-labelledby="notifications-audit-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="notifications-audit-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
            <Shield className="h-4 w-4 text-gray-500" aria-hidden="true" />
            Change watching
          </h3>
          <p className="max-w-3xl text-sm text-gray-600">Polls the audit log of each service you pick and sends one digest per service through your rules, as the "Intune change" and "Conditional Access change" event types. Only names, change types and times are read. Request bodies, setting values and policy content are never read or sent.</p>
        </div>
        <Chip tone={watching.length ? "success" : "neutral"}>{watching.length ? `Watching ${watching.join(" and ")}` : "Off"}</Chip>
      </div>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (licensed || turningOff) save.mutate() }}>
        <fieldset className="space-y-2">
          <legend className="text-sm text-gray-700">Services, while TenuVault is running</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <ServiceCard
              title="Intune"
              description="The Intune audit log: configuration, compliance, apps, scripts, enrollment and roles."
              requirement="Uses the permissions TenuVault already has."
              checked={enabled}
              disabled={!licensed && !auditWatch?.enabled}
              onChange={setEnabled}
              lastPollAt={auditWatch?.enabled ? auditWatch.lastPollAt : null}
              lastError={auditWatch?.enabled ? auditWatch.lastError : null}
            />
            <ServiceCard
              title="Conditional Access"
              description="Policies, named locations and authentication strengths, from the Entra audit log."
              requirement="Needs the delegated AuditLog.Read.All permission (setup switch -IncludeAuditLog) and a role that can read audit logs, such as Security Reader."
              checked={caEnabled}
              disabled={!licensed && !auditWatch?.conditionalAccess?.enabled}
              onChange={setCaEnabled}
              lastPollAt={auditWatch?.conditionalAccess?.enabled ? auditWatch.conditionalAccess.lastPollAt : null}
              lastError={auditWatch?.conditionalAccess?.enabled ? auditWatch.conditionalAccess.lastError : null}
            />
          </div>
        </fieldset>
        {!licensed && savedOn && <p className="text-xs text-gray-500" role="note">This tenant no longer includes notifications. You can still turn change watching off here; turning it back on needs the plan.</p>}
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input type="checkbox" className="size-4 accent-coral-600" checked={externalWatcher} disabled={!licensed} onChange={(event) => setExternalWatcher(event.target.checked)} />
            An Azure watcher owns change alerts for this tenant
          </label>
          <p className="text-xs text-gray-500">With this on, desktop polling stands down for this tenant so each change is reported once, by the Azure watcher. TenuVault then checks the watcher's heartbeat every 30 minutes and alerts ("Watcher stale") when it has not run for {WATCHER_STALE_LABEL}.</p>
          {auditWatch?.externalWatcher && (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
              {!check && <span className="text-gray-500">The watcher heartbeat has not been checked yet.</span>}
              {check && !check.error && (
                <Chip tone={check.stale ? "danger" : "success"}>{check.lastRunAt ? `Azure watcher last ran ${formatTime(check.lastRunAt)}` : "No watcher heartbeat found"}</Chip>
              )}
              {check?.error && <span className="text-red-700" role="status">Heartbeat could not be read: {check.error}</span>}
              {check && <span className="text-xs text-gray-500">Checked {formatTime(check.checkedAt)}</span>}
              <Button type="button" size="sm" variant="ghost" disabled={!licensed || checkWatcher.isPending} onClick={() => checkWatcher.mutate()}>{checkWatcher.isPending ? "Checking" : "Check now"}</Button>
            </div>
          )}
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
        {enabled && <CategoryPicker tenant={tenant} selected={categories} disabled={!licensed} onChange={setCategories} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={save.isPending || (!licensed && !turningOff)}>{save.isPending ? "Saving" : "Save change watching"}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => poll.mutate()} disabled={!licensed || poll.isPending || pollBlocked !== null} aria-describedby={pollBlocked ? "notifications-poll-blocked" : undefined}>{poll.isPending ? "Polling" : "Poll now"}</Button>
        </div>
        {pollBlocked && <p id="notifications-poll-blocked" className="text-xs text-gray-500">{pollBlocked}</p>}
      </form>
    </Tile>
  )
}

const WATCHER_STALE_LABEL = "3 hours"

/** One watched service: its switch, what it reads, what it needs, and its last poll. */
function ServiceCard({ title, description, requirement, checked, disabled, onChange, lastPollAt, lastError }: { title: string; description: string; requirement: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void; lastPollAt: string | null; lastError: string | null }) {
  return (
    <label className={`flex gap-3 rounded-2xl border p-4 transition-colors ${checked ? "border-gray-900 bg-gray-50 dark:border-gray-200 dark:bg-gray-900" : "border-gray-200 dark:border-gray-800"} ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-coral-600" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-gray-900">{title}</span>
        <span className="block text-sm text-gray-600">{description}</span>
        <span className="block text-xs text-gray-500">{requirement}</span>
        {lastPollAt && !lastError && <span className="block text-xs text-gray-500">Last poll {formatTime(lastPollAt)}</span>}
        {lastError && <span className="block text-xs text-red-700" role="status">Last poll failed: {lastError}</span>}
      </span>
    </label>
  )
}

/**
 * The audit categories to watch, picked from the names Intune reports. Nothing picked means
 * every category. A saved name Intune does not report (typed by hand in an earlier version)
 * stays visible so it can be removed: it would otherwise silently match nothing.
 */
function CategoryPicker({ tenant, selected, disabled, onChange }: { tenant: Tenant; selected: string[]; disabled: boolean; onChange: (next: string[]) => void }) {
  const known = useQuery({ queryKey: ["notifications-audit-categories", tenant.credentials?.tenantId], queryFn: () => notificationsApi.listAuditCategories(tenant), staleTime: 60 * 60_000, enabled: !!tenant.credentials?.tenantId })
  const available = known.data?.categories ?? []
  const lower = new Set(available.map((name) => name.toLowerCase()))
  // Judged only against the list Intune reported: while it loads, or with the built-in list, a name could look unknown wrongly.
  const unknown = known.data?.source === "graph" ? selected.filter((name) => !lower.has(name.toLowerCase())) : []
  // With only the built-in list, a saved name it lacks may still be a newer Intune category: keep it selectable, unflagged.
  const unconfirmed = known.data?.source === "known" ? selected.filter((name) => !lower.has(name.toLowerCase())) : []
  const isOn = (name: string) => selected.some((entry) => entry.toLowerCase() === name.toLowerCase())
  const toggle = (name: string) => onChange(isOn(name) ? selected.filter((entry) => entry.toLowerCase() !== name.toLowerCase()) : [...selected, name])
  const pill = (on: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50 ${on ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"}`
  return (
    <fieldset className="space-y-2">
      <legend className="flex flex-wrap items-baseline gap-2 text-sm text-gray-700">
        Audit categories
        <span className="text-xs text-gray-500">{selected.length === 0 ? "All categories are watched." : `${selected.length} picked. Only these are watched.`}</span>
      </legend>
      {known.isLoading && <p className="text-sm text-gray-500">Loading the categories Intune reports...</p>}
      <div className="flex flex-wrap gap-2">
        {available.map((name) => (
          <button key={name} type="button" className={pill(isOn(name))} aria-pressed={isOn(name)} disabled={disabled} onClick={() => toggle(name)} title={name}>
            {categoryLabel(name)}
          </button>
        ))}
        {unconfirmed.map((name) => (
          <button key={`saved-${name}`} type="button" className={pill(true)} aria-pressed={true} disabled={disabled} onClick={() => toggle(name)} title={name}>
            {categoryLabel(name)}
          </button>
        ))}
        {unknown.map((name) => (
          <button key={`unknown-${name}`} type="button" className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" disabled={disabled} onClick={() => toggle(name)} aria-label={`Remove ${name}, not an Intune audit category`}>
            {name} <span className="text-xs">(not an Intune category)</span> <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ))}
      </div>
      {selected.length > 0 && (
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onChange([])}>Watch all categories</Button>
      )}
      {known.data?.source === "known" && <p className="text-xs text-gray-500">Intune could not be asked for its categories, so this is the list TenuVault knows. Sign in to load the current list.</p>}
      {unknown.length > 0 && <p className="text-xs text-amber-700" role="status">A saved category is not one Intune reports, so it matches no change. Remove it and save.</p>}
    </fieldset>
  )
}
