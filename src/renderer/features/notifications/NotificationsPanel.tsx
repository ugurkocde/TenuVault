import { useEffect, useState, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Bell, Building2, Cloud, Copy, Eye, History, Pencil, Plus, RotateCw, Search, Shield, Siren, Trash2, X } from "lucide-react"
import { useTenants } from "~/contexts/TenantContext"
import type { Plan } from "../../../shared/plans"
import { emailHtml, cardOf, teamsWorkflowsPayload } from "../../../shared/notifications/render"
import { DEFAULT_CARD_LAYOUT, styleFor } from "../../../shared/notifications/layout"
import { canUse } from "../../components/PlanGate"
import { PlanBadge, UpgradeNote } from "../../components/UpgradeNote"
import { settingsHref } from "../../lib/settings-section"
import { CardPreview } from "./CardPreview"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip, Tile } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType, type NotificationSeverity } from "../../../shared/notifications/envelope"
import { CHANGE_TYPES, describeConditions, MAX_EACH_PER_CHECK, type AlertConditions, type AlertDelivery } from "../../../shared/notifications/alerts"
import type { AuditChangeType } from "../../../shared/notifications/audit"
import { toast } from "../../lib/toast"
import type { FeatureTabProps } from "../types"
import { TeamsCardTile } from "./CardLayoutEditor"
import { useOptionalPermission } from "./optional-permissions"
import type { OptionalPermissionStatus } from "../../../shared/services/optional-permissions"
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
  type NotificationsStatus,
  type AlertPreview,
  type PublicChannel,
  type UpdateChannelBody,
} from "./api"

const SEVERITIES: NotificationSeverity[] = ["info", "warning", "critical"]
const INTERVALS = [5, 15, 30, 60, 240, 1440]
const failed = (error: unknown) => toast(error instanceof Error ? error.message : "The request failed.", "error")
const selectClass = "h-8 rounded-full border border-gray-200 bg-white px-3 text-sm dark:bg-input/30"

/** The notification state of one tenant, shared by the Alerts page tabs through the query cache. */
function useNotificationsStatus(tenant: Tenant) {
  const tenantId = tenant.credentials?.tenantId
  const client = useQueryClient()
  const status = useQuery({ queryKey: ["notifications-status", tenantId], queryFn: () => notificationsApi.status(tenant), enabled: !!tenantId })
  const refresh = () => void client.invalidateQueries({ queryKey: ["notifications-status", tenantId] })
  return { status, refresh }
}

/** Loading and error states of a tab; renders the tab once the status is there. */
function WithStatus({ tenant, children }: { tenant: Tenant; children: (data: NotificationsStatus, refresh: () => void) => ReactNode }) {
  const { status, refresh } = useNotificationsStatus(tenant)
  if (status.isLoading) return <p className="text-sm text-gray-500">Loading alert settings...</p>
  if (status.error) return <p className="text-sm text-red-700" role="alert">{status.error instanceof Error ? status.error.message : "Alert settings could not be loaded."}</p>
  if (!status.data) return null
  return <>{children(status.data, refresh)}</>
}

/** Whether a tenant ever set anything up, so a tab below a locked preview can show it or stay empty. */
const hasStored = (data: NotificationsStatus) => data.channels.length > 0 || data.rules.length > 0 || Boolean(data.auditWatch?.enabled || data.auditWatch?.conditionalAccess?.enabled)

/**
 * The tabs of the Alerts page, for the tenant selected in the sidebar. Without the plan the
 * page shows its locked preview above; a tab then shows only what was stored on an earlier
 * plan, where turning things off and removing them stays free, and nothing otherwise.
 */
export function AlertsTab({ tenant, plan, allowed }: FeatureTabProps) {
  // "Alert me about this policy" elsewhere in the app opens this tab with a prefilled alert.
  const [params, setParams] = useSearchParams()
  const alertFor = params.get("alertFor")
  const prefill: AlertDraft | null = alertFor
    ? {
        title: `Changes to ${alertFor}`.slice(0, 120),
        eventTypes: [params.get("service") === "conditionalAccess" ? "entra.change" : "intune.change"],
        minSeverity: "info",
        delivery: "each",
        // The name of one policy picked elsewhere in the app: only that policy, not others containing it.
        conditions: { policyNames: [alertFor.slice(0, 200)], policyNameMatch: "exact" },
      }
    : null
  return (
    <WithStatus tenant={tenant}>
      {(data, refresh) => !allowed && !hasStored(data) ? null : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600" role="note">{data.runtimeNote}</p>
          <WatcherSyncCard tenant={tenant} data={data} onChanged={refresh} />
          <RulesTile tenant={tenant} data={data} plan={plan} prefill={prefill} onPrefillUsed={() => setParams({}, { replace: true })} onChanged={refresh} />
        </div>
      )}
    </WithStatus>
  )
}

export function ChannelsTab({ tenant, allowed }: FeatureTabProps) {
  return (
    <WithStatus tenant={tenant}>
      {(data, refresh) => !allowed && !hasStored(data) ? null : (
        <div className="space-y-4">
          <ChannelsTile tenant={tenant} channels={data.channels} rules={data.rules} licensed={data.licensed} active onChanged={refresh} />
          <TeamsCardTile tenant={tenant} channels={data.channels} licensed={data.licensed} active />
        </div>
      )}
    </WithStatus>
  )
}

export function WatchingTab({ tenant, allowed }: FeatureTabProps) {
  return (
    <WithStatus tenant={tenant}>
      {(data, refresh) => !allowed && !hasStored(data) ? null : <AuditWatchTile tenant={tenant} auditWatch={data.auditWatch} licensed={data.licensed} onChanged={refresh} />}
    </WithStatus>
  )
}

export function DeliveriesTab({ tenant, allowed }: FeatureTabProps) {
  return (
    <WithStatus tenant={tenant}>
      {(data, refresh) => !allowed && data.deliveries.length === 0 ? null : <DeliveriesTile tenant={tenant} data={data} onChanged={refresh} />}
    </WithStatus>
  )
}

const DELIVERY_FILTERS = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "pending", label: "Waiting" },
  { id: "sent", label: "Sent" },
] as const

function DeliveriesTile({ tenant, data, onChanged }: { tenant: Tenant; data: NotificationsStatus; onChanged: () => void }) {
  const [filter, setFilter] = useState<(typeof DELIVERY_FILTERS)[number]["id"]>("all")
  const [viewing, setViewing] = useState<string | null>(null)
  const retry = useMutation({
    mutationFn: (deliveryId: string) => notificationsApi.retryDelivery(tenant, deliveryId),
    onSuccess: (result) => { toast(result.state === "sent" ? "Delivered" : result.lastError ? `Still failing: ${result.lastError}` : "Queued again", result.state === "sent" ? "success" : "error"); onChanged() },
    onError: failed,
  })
  const shown = data.deliveries.filter((delivery) => filter === "all" || delivery.state === filter)
  const count = (state: string) => data.deliveries.filter((delivery) => delivery.state === state).length
  return (
    <Tile aria-labelledby="notifications-deliveries-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="notifications-deliveries-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
          <History className="h-4 w-4 text-gray-500" aria-hidden="true" />
          Recent deliveries
        </h3>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show deliveries">
          {DELIVERY_FILTERS.map((entry) => (
            <button key={entry.id} type="button" className={pillClass(filter === entry.id)} aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>
              {entry.label}{entry.id !== "all" && ` (${count(entry.id)})`}
            </button>
          ))}
        </div>
      </div>
      {data.deliveries.length === 0 && <p className="text-sm text-gray-500">Nothing has been delivered yet. Send a test from an alert or a channel to see it here.</p>}
      {data.deliveries.length > 0 && shown.length === 0 && <p className="text-sm text-gray-500">No delivery matches this filter.</p>}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {shown.map((delivery) => (
          <li key={delivery.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
            <Chip tone={delivery.state === "sent" ? "success" : delivery.state === "failed" ? "danger" : "warning"}>{delivery.state === "pending" ? "waiting" : delivery.state}</Chip>
            <span className="font-medium text-gray-900">{delivery.title}</span>
            <span className="text-gray-500">to {delivery.channelTitle} · {delivery.eventType} · {formatTime(delivery.at)}</span>
            {delivery.attempts > 1 && <span className="text-gray-500">{delivery.attempts} attempts</span>}
            {delivery.lastError && <span className="text-red-700" role="status">{delivery.lastError}</span>}
            <span className="ml-auto flex gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setViewing(delivery.id)}><Eye className="h-4 w-4" aria-hidden="true" />View</Button>
              {delivery.state === "failed" && <Button type="button" size="sm" variant="outline" disabled={!data.licensed || retry.isPending} onClick={() => retry.mutate(delivery.id)}><RotateCw className="h-4 w-4" aria-hidden="true" />{retry.isPending && retry.variables === delivery.id ? "Retrying" : "Retry"}</Button>}
            </span>
          </li>
        ))}
      </ul>
      {viewing && <DeliveryDialog tenant={tenant} deliveryId={viewing} onClose={() => setViewing(null)} />}
    </Tile>
  )
}

/** One delivery as it was sent: the mail, the Teams card and the webhook JSON, built from the stored event. */
function DeliveryDialog({ tenant, deliveryId, onClose }: { tenant: Tenant; deliveryId: string; onClose: () => void }) {
  const detail = useQuery({ queryKey: ["notifications-delivery", tenant.credentials?.tenantId, deliveryId], queryFn: () => notificationsApi.getDelivery(tenant, deliveryId) })
  const layout = useQuery({ queryKey: ["notifications-card-layout", tenant.credentials?.tenantId], queryFn: () => notificationsApi.getCardLayout(tenant), staleTime: 60_000 })
  const [view, setView] = useState<"message" | "teams" | "json">("message")
  const envelope = detail.data?.envelope
  useEffect(() => {
    if (detail.data?.channelKind === "teams") setView("teams")
    else if (detail.data?.channelKind === "webhook") setView("json")
  }, [detail.data?.channelKind])
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{envelope?.title ?? "Delivery"}</DialogTitle>
          <DialogDescription>
            {detail.data ? `To ${detail.data.channelTitle}, ${detail.data.state === "pending" ? "waiting" : detail.data.state}${detail.data.attempts > 1 ? ` after ${detail.data.attempts} attempts` : ""}${detail.data.sentAt ? `, ${formatTime(detail.data.sentAt)}` : ""}.` : "Loading the delivery..."}
          </DialogDescription>
        </DialogHeader>
        {detail.error && <p className="text-sm text-red-700" role="alert">{detail.error instanceof Error ? detail.error.message : "The delivery could not be loaded."}</p>}
        {detail.data?.lastError && <p className="text-sm text-red-700" role="status">Last error: {detail.data.lastError}</p>}
        {envelope && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Show as">
              {(["message", "teams", "json"] as const).map((entry) => (
                <button key={entry} type="button" className={pillClass(view === entry)} aria-pressed={view === entry} onClick={() => setView(entry)}>{entry === "message" ? "Email" : entry === "teams" ? "Teams card" : "Webhook JSON"}</button>
              ))}
            </div>
            {view === "message" && <iframe title="Email as sent" sandbox="" className="h-[520px] w-full rounded-2xl border border-gray-200 bg-white" srcDoc={`<!doctype html><meta charset="utf-8">${emailHtml(envelope)}`} />}
            {view === "teams" && <div className="rounded-2xl bg-gray-50 p-4 dark:bg-gray-900"><CardPreview card={cardOf(teamsWorkflowsPayload(envelope, styleFor(layout.data?.layout ?? DEFAULT_CARD_LAYOUT, envelope.type)))} theme="light" /></div>}
            {view === "json" && <pre className="max-h-[520px] overflow-auto rounded-2xl bg-gray-50 p-4 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100" tabIndex={0}>{JSON.stringify(envelope, null, 2)}</pre>}
            <p className="text-xs text-gray-500">Built again from the stored event with today's design, so a card layout changed since may look different from what arrived.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Links between the tabs of the Alerts page. */
export const ALERTS_TAB_HREF = { alerts: "/portal/alerts/alerts", channels: "/portal/alerts/channels", watching: "/portal/alerts/watching", deliveries: "/portal/alerts/deliveries" } as const

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
          <p className="max-w-3xl text-sm text-gray-600">Where notifications go. A channel on its own sends nothing: an alert on the Alerts tab sends events to it. Messages carry names, counts, statuses and the names of changed settings, never setting values, policy content, tokens or credentials.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!hasLocal && <Button type="button" variant="outline" size="sm" disabled={!licensed || addLocal.isPending} onClick={() => addLocal.mutate()}>Notify on this computer</Button>}
          <Button type="button" variant="outline" size="sm" disabled={!licensed} onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden="true" />Add channel</Button>
        </div>
      </div>
      {channels.length === 0 && <p className="text-sm text-gray-500">No channels yet. Events are only shown inside TenuVault.</p>}
      {channels.length > 0 && rules.length === 0 && <p className="text-sm text-gray-500">No alert sends to these channels yet. <Link className="font-medium text-gray-900 underline underline-offset-2" to={ALERTS_TAB_HREF.alerts}>Add an alert</Link></p>}
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
  // Called for every row (hooks cannot be conditional); only email rows use the answer.
  const mailPermission = useOptionalPermission(tenant, "notificationEmail")
  const groupPermission = useOptionalPermission(tenant, "groupRecipients")
  const mailWarning = channel.kind !== "email"
    ? null
    : mailPermission?.granted === false
      ? `Your sign-in does not carry ${mailPermission.missing.join(", ")} yet, so mail from this channel, including a test, fails. Add it to the app registration in Entra, grant admin consent and sign in again.`
      : groupPermission?.granted === false && channel.recipients.some((recipient) => recipient.type === "group")
        ? `Group recipients need ${groupPermission.missing.join(", ")}, which your sign-in does not carry yet; without it a group resolves to nobody.`
        : null
  const last = channel.lastDelivery
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={channel.enabled ? "success" : "neutral"}>{channel.enabled ? "On" : "Off"}</Chip>
        <span className="font-medium text-gray-900">{channel.title}</span>
        <Chip tone="neutral">{CHANNEL_KIND_LABELS[channel.kind]}</Chip>
        <span className="text-sm text-gray-500">{channelTarget(channel)}</span>
        {channel.hasSecret && <Chip tone="neutral">{channel.signRequests ? "Signing secret set" : `Secret header ${channel.headerName ?? ""} set`}</Chip>}
        <span className="text-sm text-gray-500">{ruleCount === 0 ? "Used by no alert" : `Used by ${ruleCount} alert${ruleCount === 1 ? "" : "s"}`}</span>
      </div>
      <p className={last && !last.ok ? "text-sm text-red-700" : "text-sm text-gray-600"} role={last && !last.ok ? "status" : undefined}>
        {last ? `${last.ok ? "Last delivery succeeded" : `Last delivery failed after ${last.attempts} attempts: ${last.error ?? "unknown error"}`} (${formatTime(last.at)}${last.test ? ", test" : ""})` : "Nothing delivered yet."}
      </p>
      {mailWarning && <p className="text-xs text-amber-700" role="status">{mailWarning}</p>}
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
            {rules.length === 1 ? "1 alert sends" : `${rules.length} alerts send`} to this channel. Removing it also takes it out of {rules.length === 1 ? "that alert" : "those alerts"}. To send to a new URL instead, use Edit and keep the alerts as they are.
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

function ChannelDialog({ tenant, channel, open, onClose, onSaved }: { tenant: Tenant; channel?: PublicChannel; open: boolean; onClose: () => void; onSaved: (channel?: PublicChannel) => void }) {
  const mailPermission = useOptionalPermission(tenant, "notificationEmail")
  const groupPermission = useOptionalPermission(tenant, "groupRecipients")
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
    onSuccess: (result) => { toast(editing ? "Channel saved" : "Channel added", "success"); onSaved(result.channel) },
    onError: failed,
  })
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${channel!.title}` : "Add a channel"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "URLs and secrets are never shown again. Leave those fields empty to keep what is stored. Alerts that send to this channel keep working, and queued deliveries go to the new address."
              : "Notifications carry names, counts, statuses, timestamps and the names of changed settings, never their values. Addresses, URLs and secrets entered here stay on this computer and are never shown again in full."}
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
              {mailPermission?.granted === false && <p className="text-xs text-amber-700" role="status">Your sign-in does not carry {mailPermission.missing.join(", ")} yet, so mail would fail. Add it to the app registration in Entra (setup switch {mailPermission.setupSwitch} for a new one), grant admin consent and sign in again.</p>}
              {groupPermission?.granted === false && rows.some((row) => row.type === "group") && <p className="text-xs text-amber-700" role="status">Group recipients also need {groupPermission.missing.join(", ")}; without it a group resolves to nobody.</p>}
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

/** Why an alert cannot send right now, with a fix where there is one. */
interface AlertBlocker {
  message: string
  fix?: { label: string; run: () => Promise<unknown> }
  href?: { label: string; to: string }
}

/**
 * The reasons an enabled alert sends nothing today: change watching off for a service it
 * listens to, a missing audit log permission, a failed last check, or a signed out tenant.
 * Desktop watching does not apply while an Azure watcher owns the tenant.
 */
function useAlertBlockers(tenant: Tenant, data: NotificationsStatus, onChanged: () => void): (rule: Pick<NotificationRule, "enabled" | "eventTypes">) => AlertBlocker[] {
  const auditLog = useOptionalPermission(tenant, "conditionalAccessWatching")
  const watch = data.auditWatch
  const turnOn = (body: { enabled?: boolean; conditionalAccessEnabled?: boolean }, what: string) => async () => {
    try {
      await notificationsApi.updateAuditWatch(tenant, body)
      toast(`${what} change watching is on`, "success")
      onChanged()
    } catch (error) {
      failed(error)
    }
  }
  return (rule) => {
    if (!rule.enabled || watch?.externalWatcher) return []
    const blockers: AlertBlocker[] = []
    const intune = rule.eventTypes.includes("intune.change")
    const ca = rule.eventTypes.includes("entra.change")
    if (intune && !watch?.enabled) blockers.push({ message: "Intune change watching is off, so this alert gets no Intune changes.", fix: { label: "Turn on Intune watching", run: turnOn({ enabled: true }, "Intune") } })
    else if (intune && watch?.lastError) blockers.push({ message: `The last Intune check failed: ${watch.lastError}`, href: { label: "Open Change watching", to: ALERTS_TAB_HREF.watching } })
    if (ca && !watch?.conditionalAccess?.enabled) blockers.push({ message: "Conditional Access change watching is off, so this alert gets no Conditional Access changes.", fix: { label: "Turn on Conditional Access watching", run: turnOn({ conditionalAccessEnabled: true }, "Conditional Access") } })
    else if (ca && auditLog?.granted === false) blockers.push({ message: `Your sign-in does not carry ${auditLog.missing.join(", ")}, which Conditional Access watching needs. Add it to the app registration in Entra, grant admin consent and sign in again.` })
    else if (ca && watch?.conditionalAccess?.lastError) blockers.push({ message: `The last Conditional Access check failed: ${watch.conditionalAccess.lastError}`, href: { label: "Open Change watching", to: ALERTS_TAB_HREF.watching } })
    if ((intune || ca) && data.signedIn === false) blockers.push({ message: "This computer is signed out of the tenant, so change watching waits until you sign in.", href: { label: "Open sign-in", to: settingsHref("signin") } })
    return blockers
  }
}

function BlockerList({ blockers }: { blockers: AlertBlocker[] }) {
  const [running, setRunning] = useState<string | null>(null)
  if (!blockers.length) return null
  return (
    <ul className="space-y-1.5 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100" role="status">
      {blockers.map((blocker) => (
        <li key={blocker.message} className="flex flex-wrap items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{blocker.message}</span>
          {blocker.fix && (
            <Button type="button" size="sm" variant="outline" disabled={running !== null} onClick={() => { setRunning(blocker.message); void blocker.fix!.run().finally(() => setRunning(null)) }}>
              {running === blocker.message ? "Turning on" : blocker.fix.label}
            </Button>
          )}
          {blocker.href && <Link className="font-medium underline underline-offset-2" to={blocker.href.to}>{blocker.href.label}</Link>}
        </li>
      ))}
    </ul>
  )
}

/** Copies the alerts for the Azure watcher and says what the watcher will and will not send. */
function useCopyForWatcher(tenant: Tenant) {
  return useMutation({
    mutationFn: () => notificationsApi.exportWatcherAlerts(tenant),
    onSuccess: async (result) => {
      if (result.document.alerts.length === 0) {
        toast("No alert sends to a webhook, Teams or email channel, so there is nothing for the Azure watcher. It cannot use This computer channels.", "error")
        return
      }
      try {
        await navigator.clipboard.writeText(result.json)
        const skipped = result.skipped.length ? ` Left out (only This computer channels): ${result.skipped.join(", ")}.` : ""
        const uncovered = result.uncovered.length ? ` The watcher will not send ${result.uncovered.map((type) => EVENT_TYPE_LABELS[type] ?? type).join(", ")}: no alert takes them.` : ""
        toast(`Alerts copied. Save them as a .json file and pass it to the watcher setup with -AlertRulesPath, or use Update watcher on the Azure watcher card.${skipped}${uncovered}`, "success")
      } catch {
        toast("The alerts could not be copied to the clipboard.", "error")
      }
    },
    onError: failed,
  })
}

/**
 * While an Azure watcher owns the tenant: whether it runs the alerts on this page, from the
 * alerts hash in its last heartbeat. "Update watcher" writes them to the watcher's alerts.json,
 * which runbook 1.2.0 and later read on every run; older runbooks need one setup rerun first.
 */
function WatcherSyncCard({ tenant, data, onChanged }: { tenant: Tenant; data: NotificationsStatus; onChanged: () => void }) {
  const copy = useCopyForWatcher(tenant)
  const check = useMutation({
    mutationFn: () => notificationsApi.runWatcherCheck(tenant),
    onSuccess: (result) => { if (result.error) toast(`The watcher heartbeat could not be read: ${result.error}`, "error"); onChanged() },
    onError: failed,
  })
  const push = useMutation({
    mutationFn: () => notificationsApi.pushWatcherAlerts(tenant),
    onSuccess: (result) => {
      const skipped = result.skipped?.length ? ` Left out (only This computer channels): ${result.skipped.join(", ")}.` : ""
      const uncovered = result.uncovered?.length ? ` The watcher will not send ${result.uncovered.map((type) => EVENT_TYPE_LABELS[type] ?? type).join(", ")}: no alert takes them.` : ""
      toast(`Alerts sent to the Azure watcher. It uses them from its next run.${skipped}${uncovered}`, "success")
      onChanged()
    },
    onError: (error) => { failed(error); onChanged() },
  })
  const auto = useMutation({
    mutationFn: (on: boolean) => notificationsApi.pushWatcherAlerts(tenant, { auto: on, write: on }),
    onSuccess: (_result, on) => { toast(on ? "The watcher now gets your alerts whenever an alert or channel changes." : "The watcher gets your alerts only when you update it.", "success"); onChanged() },
    onError: (error) => { failed(error); onChanged() },
  })
  if (!data.auditWatch?.externalWatcher) return null
  const sync = data.watcherAlerts
  const current = sync?.current ?? "none"
  const reported = sync?.reported ?? null
  const checkedAt = data.auditWatch.watcherCheck?.checkedAt
  const oldRunbook = sync?.readsAlertsFile === false
  const lastRunAt = data.auditWatch.watcherCheck?.lastRunAt ?? null
  const sentAndWaiting = Boolean(sync?.pushedHash && sync.pushedHash === current && reported !== current)
  // A run after the update that still reports other alerts did not take them: say so instead of waiting forever.
  const ranWithout = sentAndWaiting && Boolean(lastRunAt && sync?.pushedAt && Date.parse(lastRunAt) > Date.parse(sync.pushedAt))
  const sentNotRun = sentAndWaiting && !ranWithout
  const failedAfterPush = Boolean(sync?.error && (!sync.pushedAt || (sync.errorAt ?? "") > sync.pushedAt))
  const stale = data.auditWatch.watcherCheck?.stale === true
  // A stale heartbeat says nothing about what the watcher runs now, so it comes first.
  const state: { tone: "success" | "warning" | "neutral"; chip: string; text: string } =
    stale
      ? { tone: "warning", chip: "Not running", text: lastRunAt ? `The watcher last ran ${formatTime(lastRunAt)}, so what it reported then may no longer hold. Check its schedule and job history in the Automation account.` : "The watcher has not written a heartbeat yet. Check its schedule and job history in the Automation account." }
    : oldRunbook
      ? { tone: "warning", chip: "Needs a setup rerun", text: `The watcher runs runbook ${sync?.runbookVersion}, which takes its alerts only from its setup. Rerun the watcher setup script once with the current release to upgrade it. After that, Update watcher sends your alerts from here.` }
      : ranWithout
        ? { tone: "warning", chip: "Not using the update", text: `The watcher ran ${formatTime(lastRunAt!)}, after these alerts were sent, but still runs ${sync?.source === "setup" ? "the alerts from its setup" : reported === "none" ? "no alerts" : "other alerts"}. It may not be able to read alerts.json: check the job output in the Automation account, or rerun its setup with -AlertRulesPath.` }
      : sentNotRun
        ? { tone: "neutral", chip: "Waiting for its next run", text: `These alerts were sent to the watcher ${formatTime(sync!.pushedAt!)}. It uses them from its next run.` }
        : !checkedAt || reported === null
          ? { tone: "neutral", chip: "Unknown", text: checkedAt ? "The Azure watcher has not said which alerts it runs. Update it, or check again after its next run." : "The Azure watcher has not been checked yet." }
          : reported === "unreadable"
            ? { tone: "warning", chip: "Needs an update", text: "The Azure watcher cannot read its alerts, so it sends every event to every destination. Update it to send the alerts on this page." }
            : reported === current
              ? { tone: "success", chip: "Up to date", text: current === "none" ? "The Azure watcher has no alerts and sends every event to every destination it has, as these alerts would." : "The Azure watcher runs the alerts on this page." }
              : { tone: "warning", chip: "Needs an update", text: reported === "none" ? "The Azure watcher has no alerts yet, so it sends every event to every destination. Update it to send the alerts on this page." : "The Azure watcher runs older alerts than these. Update it to send the alerts on this page." }
  return (
    <Tile aria-labelledby="notifications-watcher-sync-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="notifications-watcher-sync-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
          <Cloud className="h-4 w-4 text-gray-500" aria-hidden="true" />
          Azure watcher
        </h3>
        <Chip tone={state.tone}>{state.chip}</Chip>
      </div>
      <p className="text-sm text-gray-600">An Azure watcher owns change alerts for this tenant, so it sends them while this computer is off. {state.text}</p>
      {failedAfterPush && <p className="text-sm text-red-700" role="alert">The last update did not reach the watcher: {sync!.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={push.isPending || !data.licensed} onClick={() => push.mutate()}><RotateCw className="h-4 w-4" aria-hidden="true" />{push.isPending ? "Updating" : "Update watcher"}</Button>
        <Button type="button" size="sm" variant="outline" disabled={copy.isPending || !data.licensed} onClick={() => copy.mutate()}><Copy className="h-4 w-4" aria-hidden="true" />Copy for Azure watcher</Button>
        <Button type="button" size="sm" variant="ghost" disabled={check.isPending || !data.licensed} onClick={() => check.mutate()}>{check.isPending ? "Checking" : "Check now"}</Button>
        {checkedAt && <span className="text-xs text-gray-500">Checked {formatTime(checkedAt)}</span>}
      </div>
      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" className="mt-0.5 size-4 accent-coral-600" checked={sync?.auto ?? false} disabled={auto.isPending || !data.licensed} onChange={(event) => auto.mutate(event.target.checked)} />
        <span>Update the watcher whenever an alert or channel changes<span className="block text-xs text-gray-500">Writes the alerts to alerts.json in the watcher's storage container with your sign-in. The watcher reads them on its next run, so the setup script does not run again.</span></span>
      </label>
    </Tile>
  )
}

function RulesTile({ tenant, data, plan, prefill, onPrefillUsed, onChanged }: { tenant: Tenant; data: NotificationsStatus; plan: Plan | null; prefill: AlertDraft | null; onPrefillUsed: () => void; onChanged: () => void }) {
  const { rules, channels, licensed } = data
  const [adding, setAdding] = useState<AlertDraft | null>(null)
  const [editing, setEditing] = useState<NotificationRule | null>(null)
  const [copying, setCopying] = useState(false)
  const otherTenants = useTenants().filter((candidate) => candidate.credentials?.tenantId && candidate.credentials.tenantId !== tenant.credentials?.tenantId)
  const blockersOf = useAlertBlockers(tenant, data, onChanged)
  const known = new Set(channels.map((channel) => channel.id))
  const channelTitle = (id: string) => channels.find((channel) => channel.id === id)?.title ?? "Removed channel"
  const copyForWatcher = useCopyForWatcher(tenant)
  useEffect(() => {
    if (prefill && licensed) {
      setAdding(prefill)
      onPrefillUsed()
    }
  }, [prefill, licensed])
  return (
    <Tile aria-labelledby="notifications-rules-heading" className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="notifications-rules-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
            <Siren className="h-4 w-4 text-gray-500" aria-hidden="true" />
            Alerts
          </h3>
          <p className="max-w-3xl text-sm text-gray-600">An alert sends matching events, at or above its minimum severity, to its channels. Alerts on Intune or Conditional Access changes can pick which changes they send, for example only a policy you care about, and send each change on its own.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={!licensed || rules.length === 0 || copyForWatcher.isPending} onClick={() => copyForWatcher.mutate()}><Copy className="h-4 w-4" aria-hidden="true" />Copy for Azure watcher</Button>
          {otherTenants.length > 0 && (
            <Button type="button" variant="ghost" size="sm" disabled={!licensed || rules.length === 0} onClick={() => setCopying(true)}>
              <Building2 className="h-4 w-4" aria-hidden="true" />Copy to other tenants
              {!canUse(plan, "portfolio") && plan !== null && <PlanBadge feature="portfolio" />}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" disabled={!licensed} onClick={() => setAdding({})}><Plus className="h-4 w-4" aria-hidden="true" />Add alert</Button>
        </div>
      </div>
      {rules.length === 0 && (
        <p className="text-sm text-gray-500">
          No alerts yet. {channels.length === 0 ? "Add one from a template; you can add its channel in the same dialog." : "Channels stay quiet until an alert sends events to them."}
        </p>
      )}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {rules.map((rule) => (
          <RuleRow key={rule.id} tenant={tenant} rule={rule} licensed={licensed} blockers={blockersOf(rule)} onChanged={onChanged} onEdit={() => setEditing(rule)} channelTitle={channelTitle} removedChannels={rule.channelIds.filter((id) => !known.has(id)).length} />
        ))}
      </ul>
      {adding && <RuleDialog tenant={tenant} data={data} draft={adding} open onClose={() => setAdding(null)} onSaved={() => { setAdding(null); onChanged() }} onChannelAdded={onChanged} />}
      {editing && <RuleDialog tenant={tenant} data={data} rule={editing} open onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} onChannelAdded={onChanged} />}
      {copying && <CopyAlertsDialog tenant={tenant} rules={rules} tenants={otherTenants} plan={plan} onClose={() => setCopying(false)} />}
    </Tile>
  )
}

const watchesChanges = (types: NotificationEventType[]) => types.some((type) => type === "intune.change" || type === "entra.change")

function RuleRow({ tenant, rule, licensed, blockers, onChanged, onEdit, channelTitle, removedChannels }: { tenant: Tenant; rule: NotificationRule; licensed: boolean; blockers: AlertBlocker[]; onChanged: () => void; onEdit: () => void; channelTitle: (id: string) => string; removedChannels: number }) {
  const update = useMutation({ mutationFn: (enabled: boolean) => notificationsApi.updateRule(tenant, rule.id, { enabled }), onSuccess: onChanged, onError: failed })
  const revoke = useMutation({ mutationFn: () => notificationsApi.revokeRule(tenant, rule.id), onSuccess: () => { toast("Alert removed", "success"); onChanged() }, onError: failed })
  const test = useMutation({
    mutationFn: () => notificationsApi.testRule(tenant, rule.id),
    onSuccess: (result) => {
      const failures = result.results.filter((entry) => !entry.ok)
      toast(failures.length ? `Test failed for ${failures.map((entry) => `${entry.channelTitle}: ${entry.error ?? "unknown error"}`).join("; ")}` : `Test alert sent to ${result.results.map((entry) => entry.channelTitle).join(", ")}`, failures.length ? "error" : "success")
      onChanged()
    },
    onError: failed,
  })
  const liveChannels = rule.channelIds.length - removedChannels
  const changes = watchesChanges(rule.eventTypes)
  const narrowed = changes ? describeConditions(rule.conditions) : null
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "On" : "Off"}</Chip>
        <span className="font-medium text-gray-900">{rule.title}</span>
        <Chip tone={rule.minSeverity === "critical" ? "danger" : rule.minSeverity === "warning" ? "warning" : "neutral"}>{rule.minSeverity} and above</Chip>
        {changes && rule.delivery === "each" && <Chip tone="neutral">One alert per change</Chip>}
        {blockers.length > 0 && <Chip tone="warning">Not sending changes</Chip>}
        {removedChannels > 0 && <Chip tone="warning">{removedChannels} removed channel{removedChannels === 1 ? "" : "s"}</Chip>}
        {liveChannels === 0 && <Chip tone="danger">Sends nowhere</Chip>}
      </div>
      <p className="text-sm text-gray-600">{rule.eventTypes.map((type) => EVENT_TYPE_LABELS[type] ?? type).join(", ")}</p>
      {narrowed && <p className="text-sm text-gray-600">Changes: {narrowed}</p>}
      <p className="text-sm text-gray-500">To: {rule.channelIds.map(channelTitle).join(", ") || "no channels"}</p>
      <BlockerList blockers={blockers} />
      {(removedChannels > 0 || liveChannels === 0) && <p className="text-xs text-amber-700" role="status">Edit the alert to pick a channel. Removed channels are dropped when you save.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => update.mutate(!rule.enabled)} disabled={!licensed || update.isPending}>{rule.enabled ? "Turn off" : "Turn on"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onEdit} disabled={!licensed}><Pencil className="h-4 w-4" aria-hidden="true" />Edit</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => test.mutate()} disabled={!licensed || test.isPending || liveChannels === 0}>{test.isPending ? "Sending" : "Send test"}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</Button>
      </div>
    </li>
  )
}

/** Event types a new rule cannot pick: shown disabled so they never look functional. Stored rules that already contain them still render in RuleRow. */
const INERT_EVENT_TYPES: ReadonlySet<NotificationEventType> = new Set(["test", "health.finding"])

const EVENT_TYPE_NOTES: Partial<Record<NotificationEventType, string>> = {
  test: "Sent from a channel Send test button and bypasses alerts",
  "watcher.stale": "While an Azure watcher owns change alerts",
  "backup.missed": "A slot missed while TenuVault was closed",
  "health.finding": "Configured on the Health review screen",
}

const CHANGE_TYPE_LABELS: Record<AuditChangeType, string> = { created: "Created", updated: "Updated", deleted: "Deleted", assigned: "Assigned", unassigned: "Unassigned", changed: "Other changes" }

const pillClass = (on: boolean) =>
  `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50 ${on ? "border-transparent bg-primary text-primary-foreground" : "border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"}`

/** One entry per line, trimmed, empty lines dropped. */
const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/** Adds a line to a one-per-line list unless it is already there (ignoring case). */
const addLine = (value: string, entry: string) => (lines(value).some((line) => line.toLowerCase() === entry.toLowerCase()) ? value : [...lines(value), entry].join("\n"))

/** A new alert's starting values: from a template, or from "Alert me about this policy" elsewhere in the app. */
export interface AlertDraft {
  title?: string
  eventTypes?: NotificationEventType[]
  minSeverity?: NotificationSeverity
  delivery?: AlertDelivery
  conditions?: Partial<AlertConditions> | null
}

const PICKABLE_TYPES = NOTIFICATION_EVENT_TYPES.filter((type) => !INERT_EVENT_TYPES.has(type))

/** Starting points for a first alert. Each fills the dialog; everything stays editable. */
export const ALERT_TEMPLATES: Array<{ id: string; label: string; draft: AlertDraft }> = [
  { id: "backups", label: "Backup problems", draft: { title: "Backup problems", eventTypes: ["backup.failed", "backup.warning", "backup.missed", "restore.failed", "restore.partial"], minSeverity: "info", delivery: "digest", conditions: null } },
  { id: "intune", label: "Every Intune change, one by one", draft: { title: "Intune changes", eventTypes: ["intune.change"], minSeverity: "info", delivery: "each", conditions: null } },
  { id: "compliance", label: "Compliance policy changes", draft: { title: "Compliance policy changes", eventTypes: ["intune.change"], minSeverity: "info", delivery: "each", conditions: { categories: ["Compliance"], changeTypes: ["updated", "deleted", "unassigned"] } } },
  { id: "ca", label: "Conditional Access changes", draft: { title: "Conditional Access changes", eventTypes: ["entra.change"], minSeverity: "info", delivery: "each", conditions: null } },
  { id: "deletions", label: "Deletions and removed assignments", draft: { title: "Deletions and removed assignments", eventTypes: ["intune.change", "entra.change"], minSeverity: "info", delivery: "each", conditions: { changeTypes: ["deleted", "unassigned"] } } },
  { id: "critical", label: "Everything critical", draft: { title: "Critical events", eventTypes: [...PICKABLE_TYPES], minSeverity: "critical", delivery: "digest", conditions: null } },
]

/** A search box over suggestions; picking one hands it to `onPick`. */
function SuggestionPicker({ items, placeholder, empty, onPick }: { items: Array<{ value: string; hint?: string }>; placeholder: string; empty: string; onPick: (value: string) => void }) {
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const matches = needle ? items.filter((item) => item.value.toLowerCase().includes(needle)).slice(0, 8) : []
  if (items.length === 0) return <p className="text-xs text-gray-500">{empty}</p>
  return (
    <div className="space-y-1.5">
      <Input value={query} maxLength={200} placeholder={placeholder} onChange={(event) => setQuery(event.target.value)} aria-label={placeholder} />
      {matches.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {matches.map((item) => (
            <li key={`${item.value}|${item.hint ?? ""}`}>
              <button type="button" className={pillClass(false)} onClick={() => { onPick(item.value); setQuery("") }} title={item.hint}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />{item.value}{item.hint && <span className="text-xs text-gray-500">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {needle && matches.length === 0 && <p className="text-xs text-gray-500">No match. Type the name in the box above instead.</p>}
    </div>
  )
}

function RuleDialog({ tenant, data, rule, draft, open, onClose, onSaved, onChannelAdded }: { tenant: Tenant; data: NotificationsStatus; rule?: NotificationRule; draft?: AlertDraft; open: boolean; onClose: () => void; onSaved: () => void; onChannelAdded: () => void }) {
  const channels = data.channels
  const editing = Boolean(rule)
  const known = new Set(channels.map((channel) => channel.id))
  // Types a rule can no longer pick stay on the rule untouched when it is edited.
  const keptInert = (rule?.eventTypes ?? []).filter((type) => INERT_EVENT_TYPES.has(type))
  const start: AlertDraft = rule ? { title: rule.title, eventTypes: rule.eventTypes, minSeverity: rule.minSeverity, delivery: rule.delivery, conditions: rule.conditions } : draft ?? {}
  const [title, setTitle] = useState(start.title ?? "")
  const [eventTypes, setEventTypes] = useState<NotificationEventType[]>((start.eventTypes ?? ["backup.failed"]).filter((type) => !INERT_EVENT_TYPES.has(type)))
  const [minSeverity, setMinSeverity] = useState<NotificationSeverity>(start.minSeverity ?? "info")
  const [channelIds, setChannelIds] = useState<string[]>(rule ? rule.channelIds.filter((id) => known.has(id)) : channels.filter((channel) => channel.enabled).map((channel) => channel.id).slice(0, 1))
  const [changeTypes, setChangeTypes] = useState<AuditChangeType[]>(start.conditions?.changeTypes ?? [])
  const [categories, setCategories] = useState<string[]>(start.conditions?.categories ?? [])
  const [policyNames, setPolicyNames] = useState((start.conditions?.policyNames ?? []).join("\n"))
  const [policyExact, setPolicyExact] = useState(start.conditions?.policyNameMatch === "exact")
  const [settingNames, setSettingNames] = useState((start.conditions?.settingNames ?? []).join("\n"))
  const [excludeActors, setExcludeActors] = useState((start.conditions?.excludeActors ?? []).join("\n"))
  const [delivery, setDelivery] = useState<AlertDelivery>(start.delivery ?? "digest")
  const [addingChannel, setAddingChannel] = useState(false)
  const [preview, setPreview] = useState<AlertPreview | null>(null)
  const applyTemplate = (template: AlertDraft) => {
    setTitle(template.title ?? "")
    setEventTypes(template.eventTypes ?? [])
    setMinSeverity(template.minSeverity ?? "info")
    setDelivery(template.delivery ?? "digest")
    setChangeTypes(template.conditions?.changeTypes ?? [])
    setCategories(template.conditions?.categories ?? [])
    setPolicyNames((template.conditions?.policyNames ?? []).join("\n"))
    setPolicyExact(template.conditions?.policyNameMatch === "exact")
    setSettingNames((template.conditions?.settingNames ?? []).join("\n"))
    setExcludeActors((template.conditions?.excludeActors ?? []).join("\n"))
    setPreview(null)
  }
  const changes = watchesChanges(eventTypes)
  const intune = eventTypes.includes("intune.change")
  const ca = eventTypes.includes("entra.change")
  const watch = data.auditWatch
  // Saving a change alert while its watching is off offers to switch watching on with it.
  const watchingOff = [intune && !watch?.externalWatcher && !watch?.enabled ? "Intune" : null, ca && !watch?.externalWatcher && !watch?.conditionalAccess?.enabled ? "Conditional Access" : null].filter((entry): entry is string => entry !== null)
  const [turnOnWatching, setTurnOnWatching] = useState(true)
  const categoryList = useQuery({ queryKey: ["notifications-audit-categories", tenant.credentials?.tenantId], queryFn: () => notificationsApi.listAuditCategories(tenant), staleTime: 60 * 60_000, enabled: open && intune && !!tenant.credentials?.tenantId })
  const suggestions = useQuery({ queryKey: ["notifications-alert-suggestions", tenant.credentials?.tenantId], queryFn: () => notificationsApi.listAlertSuggestions(tenant), staleTime: 10 * 60_000, enabled: open && changes && !!tenant.credentials?.tenantId })
  const valid = eventTypes.length + keptInert.length > 0 && channelIds.length > 0
  const conditions = (): AlertConditions | null => {
    if (!changes) return null
    const value: AlertConditions = { changeTypes, categories: intune ? categories : [], policyNames: lines(policyNames), settingNames: lines(settingNames), excludeActors: lines(excludeActors) }
    if (policyExact && value.policyNames.length) value.policyNameMatch = "exact"
    return value.changeTypes.length + value.categories.length + value.policyNames.length + value.settingNames.length + value.excludeActors.length ? value : null
  }
  const save = useMutation({
    mutationFn: async () => {
      const body = { title: title.trim() || undefined, eventTypes: [...eventTypes, ...keptInert], minSeverity, channelIds, conditions: conditions(), delivery: changes ? delivery : "digest" as const }
      if (rule) await notificationsApi.updateRule(tenant, rule.id, body)
      else await notificationsApi.addRule(tenant, { ...body, mode: "immediate" })
      // The alert is saved now. Turning watching on is a second step: its failure must not
      // leave the dialog open, where saving again would add the alert twice.
      if (!turnOnWatching || !watchingOff.length) return { watching: null as string | null }
      try {
        await notificationsApi.updateAuditWatch(tenant, { ...(watchingOff.includes("Intune") ? { enabled: true } : {}), ...(watchingOff.includes("Conditional Access") ? { conditionalAccessEnabled: true } : {}) })
        return { watching: null }
      } catch (error) {
        return { watching: error instanceof Error ? error.message : "The request failed." }
      }
    },
    onSuccess: ({ watching }) => {
      const saved = editing ? "Alert saved" : "Alert added"
      if (watching) toast(`${saved}, but change watching could not be turned on: ${watching} Turn it on from the alert's row.`, "error")
      else toast(turnOnWatching && watchingOff.length ? `${saved} and ${watchingOff.join(" and ")} change watching turned on` : saved, "success")
      onSaved()
    },
    onError: failed,
  })
  const check = useMutation({
    mutationFn: () => notificationsApi.previewRule(tenant, { eventTypes, minSeverity, conditions: conditions(), delivery }),
    onSuccess: setPreview,
    onError: failed,
  })
  const toggleEvent = (type: NotificationEventType, checked: boolean) => { setPreview(null); setEventTypes((current) => (checked ? [...current, type] : current.filter((entry) => entry !== type))) }
  const toggleChannel = (id: string, checked: boolean) => setChannelIds((current) => (checked ? [...current, id] : current.filter((entry) => entry !== id)))
  const toggleChangeType = (type: AuditChangeType) => { setPreview(null); setChangeTypes((current) => (current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type])) }
  const toggleCategory = (name: string) => { setPreview(null); setCategories((current) => (current.some((entry) => entry.toLowerCase() === name.toLowerCase()) ? current.filter((entry) => entry.toLowerCase() !== name.toLowerCase()) : [...current, name])) }
  const availableCategories = [...new Set([...(categoryList.data?.categories ?? []), ...categories])]
  const policyItems = (suggestions.data?.policies ?? []).filter((policy) => (policy.service === "intune" ? intune : ca)).map((policy) => ({ value: policy.name, hint: policy.type }))
  const settingItems = (suggestions.data?.settings ?? []).map((value) => ({ value }))
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${rule!.title}` : "Add an alert"}</DialogTitle>
          <DialogDescription>Pick the events, the lowest severity that should send, which changes count, and where the alert goes.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (valid) save.mutate() }}>
          {!editing && (
            <div className="space-y-1.5">
              <p className="text-sm text-gray-700" id="alert-templates">Start from</p>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="alert-templates">
                {ALERT_TEMPLATES.map((template) => (
                  <button key={template.id} type="button" className={pillClass(title === template.draft.title)} aria-pressed={title === template.draft.title} onClick={() => applyTemplate(template.draft)}>{template.label}</button>
                ))}
              </div>
            </div>
          )}
          <label className="block text-sm text-gray-700">Name{editing ? "" : " (optional)"}<Input className="mt-1" maxLength={120} value={title} placeholder="For example: Compliance policy changes" onChange={(event) => setTitle(event.target.value)} /></label>
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
            <p className="text-xs text-gray-500">Greyed out types cannot be picked. Test notifications bypass alerts, and health findings are configured on the Health review screen. An alert that already contains one of these types keeps it.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-gray-700">
              Minimum severity
              <select className={selectClass} value={minSeverity} onChange={(event) => { setPreview(null); setMinSeverity(event.target.value as NotificationSeverity) }}>
                {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </select>
            </label>
          </div>
          {changes && (
            <fieldset className="space-y-3 rounded-2xl border border-gray-200 p-4 dark:border-gray-800">
              <legend className="px-1 text-sm font-medium text-gray-900">Which changes</legend>
              <p className="text-xs text-gray-500">Leave everything empty to send every change. Each filter you fill in narrows the alert further. They apply to Intune and Conditional Access changes only; other event types above are sent as usual.</p>
              <div className="space-y-1.5">
                <p className="text-sm text-gray-700" id="alert-change-types">Change types</p>
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby="alert-change-types">
                  {CHANGE_TYPES.map((type) => (
                    <button key={type} type="button" className={pillClass(changeTypes.includes(type))} aria-pressed={changeTypes.includes(type)} onClick={() => toggleChangeType(type)}>{CHANGE_TYPE_LABELS[type]}</button>
                  ))}
                </div>
                <p className="text-xs text-gray-500">{changeTypes.length === 0 ? "All change types are sent." : `Only ${changeTypes.map((type) => CHANGE_TYPE_LABELS[type].toLowerCase()).join(", ")}.`}</p>
              </div>
              {intune && (
                <div className="space-y-1.5">
                  <p className="text-sm text-gray-700" id="alert-categories">Intune categories</p>
                  {categoryList.isLoading && <p className="text-sm text-gray-500">Loading the categories Intune reports...</p>}
                  <div className="flex flex-wrap gap-2" role="group" aria-labelledby="alert-categories">
                    {availableCategories.map((name) => {
                      const on = categories.some((entry) => entry.toLowerCase() === name.toLowerCase())
                      return <button key={name} type="button" className={pillClass(on)} aria-pressed={on} title={name} onClick={() => toggleCategory(name)}>{categoryLabel(name)}</button>
                    })}
                  </div>
                  <p className="text-xs text-gray-500">{categories.length === 0 ? "All categories are sent." : `Only ${categories.map(categoryLabel).join(", ")}.`} Conditional Access changes have no category and are not filtered by this.</p>
                </div>
              )}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span id="alert-policy-names-label" className="text-sm text-gray-700">{policyExact ? "Policy names are exactly" : "Policy names contain"}</span>
                  <div role="radiogroup" aria-label="How policy names match" className="flex gap-1">
                    {([[false, "Contains"], [true, "Exact name"]] as const).map(([exact, label]) => (
                      <button key={label} type="button" role="radio" aria-checked={policyExact === exact} className={pillClass(policyExact === exact)} onClick={() => { setPreview(null); setPolicyExact(exact) }}>{label}</button>
                    ))}
                  </div>
                </div>
                <label className="block text-sm text-gray-700">
                  <textarea aria-labelledby="alert-policy-names-label" className="mt-1 block w-full rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm dark:bg-input/30" rows={3} maxLength={4000} value={policyNames} placeholder="One per line, for example Windows compliance" onChange={(event) => { setPreview(null); setPolicyNames(event.target.value) }} />
                </label>
                <SuggestionPicker
                  items={policyItems}
                  placeholder="Search the policies of the newest backup"
                  empty={suggestions.isLoading ? "Loading the policies of the newest backup..." : "No backup to pick policies from yet. Type the names instead."}
                  onPick={(name) => { setPreview(null); setPolicyNames((current) => addLine(current, name)) }}
                />
                <span className="block text-xs text-gray-500">{policyExact
                  ? "A change counts only when its policy is named exactly one of these, ignoring case. Renaming the policy stops its alerts until you change the name here."
                  : "A change counts when its policy name contains one of these, ignoring case. A full name picks that policy, and any other policy whose name contains it. Choose Exact name for only that policy."}</span>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm text-gray-700">
                  Changed settings contain
                  <textarea className="mt-1 block w-full rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm dark:bg-input/30" rows={3} maxLength={4000} value={settingNames} placeholder="One per line, for example BitLocker or conditions.users" onChange={(event) => { setPreview(null); setSettingNames(event.target.value) }} />
                </label>
                <SuggestionPicker
                  items={settingItems}
                  placeholder="Search settings seen in recent alerts"
                  empty="No changed settings seen in alerts yet. Type a part of the name instead, such as BitLocker or Password."
                  onPick={(name) => { setPreview(null); setSettingNames((current) => addLine(current, name)) }}
                />
                <span className="block text-xs text-gray-500">Only updates name the settings they changed, so with this filled in, creates, deletes and assignments never count. Settings catalog policies do not name their settings in the audit log.</span>
              </div>
              <label className="block text-sm text-gray-700">
                Never alert for changes by
                <textarea className="mt-1 block w-full rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm dark:bg-input/30" rows={2} maxLength={4000} value={excludeActors} placeholder="One per line: a user principal name or an app name" onChange={(event) => { setPreview(null); setExcludeActors(event.target.value) }} />
                <span className="mt-1 block text-xs text-gray-500">Exact matches, ignoring case. Useful for automation accounts whose changes are expected.</span>
              </label>
              <div className="space-y-1.5">
                <p className="text-sm text-gray-700" id="alert-delivery">How to send</p>
                <div className="space-y-1.5" role="radiogroup" aria-labelledby="alert-delivery">
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input type="radio" name="alert-delivery" className="mt-0.5 size-4 accent-coral-600" checked={delivery === "digest"} onChange={() => { setPreview(null); setDelivery("digest") }} />
                    <span>One summary per check<span className="block text-xs text-gray-500">All matching changes from one poll in one message.</span></span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input type="radio" name="alert-delivery" className="mt-0.5 size-4 accent-coral-600" checked={delivery === "each"} onChange={() => { setPreview(null); setDelivery("each") }} />
                    <span>One alert per change<span className="block text-xs text-gray-500">Each change in its own message with its changed settings. Up to {MAX_EACH_PER_CHECK} per check; any more arrive together in one summary.</span></span>
                  </label>
                </div>
              </div>
              <div className="space-y-2 rounded-2xl bg-gray-50 p-3 dark:bg-gray-900">
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={check.isPending || data.signedIn === false} onClick={() => check.mutate()}><Search className="h-4 w-4" aria-hidden="true" />{check.isPending ? "Reading the audit logs" : "Check the last 7 days"}</Button>
                  <span className="text-xs text-gray-500">{data.signedIn === false ? "Sign in to this tenant to read its audit logs." : "Reads the audit logs and shows what this alert would have sent. Nothing is sent."}</span>
                </div>
                {preview && <PreviewResult preview={preview} />}
              </div>
            </fieldset>
          )}
          <fieldset className="space-y-1.5">
            <legend className="text-sm text-gray-700">Send to</legend>
            {channels.map((channel) => (
              <label key={channel.id} className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" className="size-4 accent-coral-600" checked={channelIds.includes(channel.id)} onChange={(event) => toggleChannel(channel.id, event.target.checked)} />
                {channel.title} <span className="text-gray-500">({CHANNEL_KIND_LABELS[channel.kind]}{channel.enabled ? "" : ", off"})</span>
              </label>
            ))}
            {channels.length === 0 && <p className="text-sm text-gray-500">No channel yet. Add one here; it is saved right away and picked for this alert.</p>}
            <Button type="button" size="sm" variant="ghost" onClick={() => setAddingChannel(true)}><Plus className="h-4 w-4" aria-hidden="true" />Add a channel</Button>
            {rule && rule.channelIds.some((id) => !known.has(id)) && <p className="text-xs text-amber-700">Removed channels are dropped from this alert when you save.</p>}
          </fieldset>
          {watchingOff.length > 0 && (
            <label className="flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              <input type="checkbox" className="mt-0.5 size-4 accent-coral-600" checked={turnOnWatching} onChange={(event) => setTurnOnWatching(event.target.checked)} />
              <span>Also turn on {watchingOff.join(" and ")} change watching. It is off, so without it this alert gets no {watchingOff.join(" or ")} changes.</span>
            </label>
          )}
          {!valid && <p className="text-sm text-gray-500">Pick at least one event type and one channel.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || !valid}>{save.isPending ? "Saving" : editing ? "Save alert" : "Add alert"}</Button>
          </div>
        </form>
        {addingChannel && (
          <ChannelDialog
            tenant={tenant}
            open
            onClose={() => setAddingChannel(false)}
            onSaved={(channel) => {
              setAddingChannel(false)
              if (channel) setChannelIds((current) => (current.includes(channel.id) ? current : [...current, channel.id]))
              onChannelAdded()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PreviewResult({ preview }: { preview: AlertPreview }) {
  const read = preview.services.reduce((sum, entry) => sum + entry.changes, 0)
  const label = (service: string) => (service === "intune" ? "Intune" : "Conditional Access")
  return (
    <div className="space-y-2 text-sm" role="status">
      <p className="text-gray-700">
        {read} {read === 1 ? "change" : "changes"} in the last {preview.days} days. This alert would have sent {preview.total === 0 ? "nothing" : `${preview.total} ${preview.total === 1 ? "message" : "messages"}`}.
      </p>
      {preview.services.filter((entry) => entry.error || entry.capped).map((entry) => (
        <p key={entry.service} className="text-xs text-amber-700">{entry.error ? `${label(entry.service)}: ${entry.error}` : `${label(entry.service)}: only the first ${entry.read} audit events were read; the preview may miss older ones.`}</p>
      ))}
      {preview.messages.length > 0 && (
        <ul className="space-y-1">
          {preview.messages.map((message, index) => (
            <li key={`${message.occurredAt}-${index}`} className="flex flex-wrap items-center gap-2">
              <Chip tone={message.severity === "critical" ? "danger" : message.severity === "warning" ? "warning" : "neutral"}>{message.severity}</Chip>
              <span className="text-gray-900">{message.title}</span>
              <span className="text-xs text-gray-500">{formatTime(message.occurredAt)}{message.changes > 1 ? ` · ${message.changes} changes` : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {preview.total > preview.messages.length && <p className="text-xs text-gray-500">And {preview.total - preview.messages.length} more.</p>}
    </div>
  )
}

/** MSP: copies alerts to other connected tenants; channels are matched there by kind. */
function CopyAlertsDialog({ tenant, rules, tenants, plan, onClose }: { tenant: Tenant; rules: NotificationRule[]; tenants: Tenant[]; plan: Plan | null; onClose: () => void }) {
  const [ruleIds, setRuleIds] = useState<string[]>(rules.map((rule) => rule.id))
  const [targetIds, setTargetIds] = useState<string[]>([])
  const allowed = canUse(plan, "portfolio")
  const copy = useMutation({ mutationFn: () => notificationsApi.copyRules(tenant, ruleIds, targetIds), onError: failed })
  const toggle = (list: string[], set: (next: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((entry) => entry !== id))
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Copy alerts to other tenants</DialogTitle>
          <DialogDescription>Each copy sends to the other tenant's channels of the same kind: Teams to its Teams channels, email to its email channels. A tenant that already has an alert with the same name keeps its own.</DialogDescription>
        </DialogHeader>
        {!allowed && plan !== null && <UpgradeNote feature="portfolio" />}
        {copy.data ? (
          <div className="space-y-3 text-sm">
            {copy.data.results.map((result) => (
              <div key={result.tenantId} className="rounded-2xl bg-gray-50 p-3 dark:bg-gray-900">
                <p className="font-medium text-gray-900">{result.tenantName}</p>
                <p className="text-gray-600">{result.created.length ? `Copied: ${result.created.join(", ")}.` : "Nothing copied."}{result.skipped.length ? ` Already there: ${result.skipped.join(", ")}.` : ""}</p>
                {result.withoutChannels.length > 0 && <p className="text-amber-700">Turned off until that tenant has a matching channel: {result.withoutChannels.join(", ")}.</p>}
                {result.full.length > 0 && <p className="text-amber-700">Not copied, the tenant already has the most alerts it can have: {result.full.join(", ")}.</p>}
              </div>
            ))}
            <div className="flex justify-end"><Button type="button" onClick={onClose}>Done</Button></div>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); copy.mutate() }}>
            <fieldset className="space-y-1.5">
              <legend className="text-sm text-gray-700">Alerts</legend>
              {rules.map((rule) => (
                <label key={rule.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="size-4 accent-coral-600" checked={ruleIds.includes(rule.id)} onChange={(event) => toggle(ruleIds, setRuleIds, rule.id, event.target.checked)} />
                  {rule.title}
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-1.5">
              <legend className="text-sm text-gray-700">Copy to</legend>
              {tenants.map((candidate) => (
                <label key={candidate.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="size-4 accent-coral-600" checked={targetIds.includes(candidate.credentials!.tenantId)} onChange={(event) => toggle(targetIds, setTargetIds, candidate.credentials!.tenantId, event.target.checked)} />
                  {candidate.name}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={!allowed || copy.isPending || ruleIds.length === 0 || targetIds.length === 0}>{copy.isPending ? "Copying" : "Copy alerts"}</Button>
            </div>
          </form>
        )}
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

  const auditLogPermission = useOptionalPermission(tenant, "conditionalAccessWatching")
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
          <p className="max-w-3xl text-sm text-gray-600">Polls the audit log of each service you pick and sends what changed through your alerts, as the "Intune change" and "Conditional Access change" event types. Alerts send names, change types, times and, for updates, the names of the settings that changed. Setting values are compared on this computer to find those names and are never kept or sent.</p>
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
              permission={auditLogPermission}
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
function ServiceCard({ title, description, requirement, checked, disabled, onChange, lastPollAt, lastError, permission }: { title: string; description: string; requirement: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void; lastPollAt: string | null; lastError: string | null; permission?: OptionalPermissionStatus | null }) {
  return (
    <label className={`flex gap-3 rounded-2xl border p-4 transition-colors ${checked ? "border-gray-900 bg-gray-50 dark:border-gray-200 dark:bg-gray-900" : "border-gray-200 dark:border-gray-800"} ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-coral-600" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-gray-900">{title}</span>
        <span className="block text-sm text-gray-600">{description}</span>
        <span className="block text-xs text-gray-500">{requirement}</span>
        {permission?.granted === true && <span className="block text-xs text-green-700">{permission.permissions.join(", ")} is granted in your sign-in.</span>}
        {permission?.granted === false && <span className="block text-xs text-amber-700" role="status">Not granted in your sign-in yet: {permission.missing.join(", ")}. Add it to the app registration in Entra, grant admin consent and sign in again.</span>}
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
