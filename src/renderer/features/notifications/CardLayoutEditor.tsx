import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from "@dnd-kit/core"
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  AlignLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  Heading,
  LayoutTemplate,
  List,
  ListChecks,
  Lock,
  Moon,
  MousePointerClick,
  Palette,
  PanelBottom,
  RotateCcw,
  Send,
  StickyNote,
  Sun,
  X,
} from "lucide-react"
import type { Tenant } from "~/contexts/TenantContext"
import { Chip, Tile } from "~/components/dashboard/tiles"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog"
import { Input } from "~/components/ui/input"
import type { NotificationSeverity } from "../../../shared/notifications/envelope"
import {
  DEFAULT_CARD_LAYOUT,
  EVENT_GROUP_IDS,
  PLACEHOLDERS,
  TEXT_LIMITS,
  isDefaultLayout,
  parseCardLayout,
  parseCardStyle,
  styleIssues,
  type CardLayout,
  type CardStyle,
  type EventGroup,
  type HideableBlock,
  type MovableBlock,
} from "../../../shared/notifications/layout"
import { cardOf, fitTeamsPayload, teamsPayloadBytes, teamsWorkflowsPayload } from "../../../shared/notifications/render"
import { toast } from "../../lib/toast"
import { notificationsApi, type PublicChannel } from "./api"
import { CardPreview, type PreviewTheme } from "./CardPreview"
import { CARD_SAMPLES, detailLabelsFor, samplesFor } from "./card-samples"

type Tab = "base" | EventGroup
type Selection = "card" | "header" | MovableBlock | "button"

const TAB_LABELS: Record<Tab, string> = { base: "Default", backups: "Backups", restores: "Restores", drift: "Drift", changes: "Changes", alerts: "Alerts" }
const TAB_HINTS: Record<EventGroup, string> = {
  backups: "Backup failed, warnings, succeeded and missed",
  restores: "Restore completed, partial and failed",
  drift: "Drift detected",
  changes: "Intune and Conditional Access changes",
  alerts: "Certificate expiring, watcher stale, health findings",
}

const BLOCKS: Record<Selection, { label: string; hint: string; icon: typeof Heading }> = {
  card: { label: "Whole card", hint: "Colors, density and times", icon: Palette },
  header: { label: "Header", hint: "Severity and title, always first", icon: Heading },
  summary: { label: "Summary", hint: "One sentence about what happened", icon: AlignLeft },
  details: { label: "Details", hint: "Facts such as counts and results", icon: List },
  items: { label: "Changes list", hint: "One line per change or item", icon: ListChecks },
  note: { label: "Note", hint: "Your own text, for example who to call", icon: StickyNote },
  footer: { label: "Footer", hint: "Sender, time and event id", icon: PanelBottom },
  button: { label: "Button", hint: "Opens a Microsoft admin center, always last", icon: MousePointerClick },
}

const failed = (error: unknown) => toast(error instanceof Error ? error.message : "The request failed.", "error")
const sameLayout = (a: CardLayout, b: CardLayout) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Settings > Notifications > Teams card: how Workflows cards look for this tenant, with a
 * live thumbnail and the editor. Applies to every Teams channel of the tenant.
 */
export function TeamsCardTile({ tenant, channels, licensed, active }: { tenant: Tenant; channels: PublicChannel[]; licensed: boolean; active: boolean }) {
  const tenantId = tenant.credentials?.tenantId
  const client = useQueryClient()
  const query = useQuery({ queryKey: ["notifications-card-layout", tenantId], queryFn: () => notificationsApi.getCardLayout(tenant), enabled: !!tenantId })
  const [editing, setEditing] = useState(false)
  const refresh = () => void client.invalidateQueries({ queryKey: ["notifications-card-layout", tenantId] })
  const reset = useMutation({ mutationFn: () => notificationsApi.resetCardLayout(tenant), onSuccess: () => { toast("Teams cards use the standard layout again", "success"); refresh() }, onError: failed })
  // Parsed again here, so a layout from an older or newer version always renders.
  const layout = useMemo(() => (query.data ? parseCardLayout(query.data.layout) : DEFAULT_CARD_LAYOUT), [query.data])
  const custom = !isDefaultLayout(layout)
  const overrides = Object.keys(layout.overrides) as EventGroup[]
  const thumbnail = useMemo(() => cardOf(teamsWorkflowsPayload(CARD_SAMPLES[0]!.envelope, layout.base)), [layout])
  const teamsChannels = channels.filter((channel) => channel.kind === "teams")

  return (
    <Tile aria-labelledby="notifications-card-heading" className="gap-4">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:items-start">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="notifications-card-heading" className="flex items-center gap-2 text-lg font-medium text-gray-900">
              <LayoutTemplate className="h-4 w-4 text-gray-500" aria-hidden="true" />
              Teams card
            </h3>
            <Chip tone={custom ? "success" : "neutral"}>{custom ? "Custom layout" : "Standard layout"}</Chip>
          </div>
          <p className="max-w-2xl text-sm text-gray-600">How alerts look in Teams channels: which parts show, in which order, and what they say. It applies to every Teams channel of this tenant and to the Azure watcher once you copy it there. Policy names and other tenant text always stay plain text, and buttons only open Microsoft admin centers.</p>
          {overrides.length > 0 && <p className="text-sm text-gray-600">Own layouts for: {overrides.map((group) => TAB_LABELS[group]).join(", ")}.</p>}
          {teamsChannels.length === 0 && <p className="text-xs text-gray-500">No Teams channel yet. You can design the card now; it is used once you add one.</p>}
          {query.error && <p className="text-sm text-red-700" role="alert">{query.error instanceof Error ? query.error.message : "The layout could not be loaded."}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => setEditing(true)} disabled={query.isLoading}><Palette className="h-4 w-4" aria-hidden="true" />{licensed ? "Customize card" : "View card layout"}</Button>
            {custom && <Button type="button" size="sm" variant="outline" disabled={reset.isPending} onClick={() => reset.mutate()}><RotateCcw className="h-4 w-4" aria-hidden="true" />Reset to standard</Button>}
          </div>
        </div>
        <div className="pointer-events-none select-none" aria-hidden="true">
          <div className="max-h-72 overflow-hidden rounded-2xl [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
            <CardPreview card={thumbnail} theme="light" compact />
          </div>
        </div>
      </div>
      {editing && query.data && (
        <CardLayoutEditor
          tenant={tenant}
          initial={layout}
          channels={teamsChannels}
          licensed={licensed}
          open={active}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh() }}
        />
      )}
    </Tile>
  )
}

function CardLayoutEditor({ tenant, initial, channels, licensed, open, onClose, onSaved }: { tenant: Tenant; initial: CardLayout; channels: PublicChannel[]; licensed: boolean; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [layout, setLayout] = useState<CardLayout>(initial)
  const [tab, setTab] = useState<Tab>("base")
  const [selected, setSelected] = useState<Selection>("card")
  const [sampleId, setSampleId] = useState(CARD_SAMPLES[0]!.id)
  const [theme, setTheme] = useState<PreviewTheme>(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"))
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [testChannelId, setTestChannelId] = useState(channels[0]?.id ?? "")

  const override = tab === "base" ? null : layout.overrides[tab] ?? null
  const usesDefault = tab !== "base" && !override
  const style = tab === "base" ? layout.base : override ?? layout.base
  const samples = samplesFor(tab)
  const sample = samples.find((entry) => entry.id === sampleId) ?? samples[0]!
  useEffect(() => {
    if (!samples.some((entry) => entry.id === sampleId)) setSampleId(samples[0]!.id)
  }, [samples, sampleId])

  // Normalized like the server and the Azure watcher do on save, so the preview shows the delivered card.
  const fitted = useMemo(() => fitTeamsPayload(sample.envelope, parseCardStyle(style)), [sample, style])
  const payload = fitted.payload
  // Judged like the senders do: the larger of UTF-8 and UTF-16, since Teams does not say how it counts.
  const bytes = useMemo(() => teamsPayloadBytes(payload), [payload])
  const dirty = !sameLayout(layout, initial)
  const allIssues = [layout.base, ...Object.values(layout.overrides)].flatMap((entry) => styleIssues(entry))
  const issues = styleIssues(style)
  const readOnly = !licensed

  const setStyle = (patch: Partial<CardStyle>) => {
    if (readOnly || usesDefault) return
    setLayout((current) => (tab === "base" ? { ...current, base: { ...current.base, ...patch } } : { ...current, overrides: { ...current.overrides, [tab]: { ...(current.overrides[tab] ?? current.base), ...patch } } }))
  }
  const customizeGroup = () => tab !== "base" && setLayout((current) => ({ ...current, overrides: { ...current.overrides, [tab]: { ...current.base } } }))
  const useDefaultForGroup = () => tab !== "base" && setLayout((current) => {
    const next = { ...current.overrides }
    delete next[tab]
    return { ...current, overrides: next }
  })

  const save = useMutation({ mutationFn: () => notificationsApi.saveCardLayout(tenant, layout), onSuccess: () => { toast("Teams card saved", "success"); onSaved() }, onError: failed })
  const test = useMutation({
    // A test event belongs to no group, so the style shown on this tab is sent as the base.
    mutationFn: () => notificationsApi.testChannel(tenant, testChannelId, { ...layout, base: style }),
    onSuccess: (result) => toast(result.delivery.ok ? "Test card sent to Teams" : `Test failed: ${result.delivery.error ?? "unknown error"}`, result.delivery.ok ? "success" : "error"),
    onError: failed,
  })
  const copyForWatcher = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(layout, null, 2))
      toast("Layout copied. Save it as a .json file and pass it to the watcher setup with -TeamsCardLayoutPath.", "success")
    } catch {
      toast("The layout could not be copied to the clipboard.", "error")
    }
  }
  const requestClose = () => (dirty && !readOnly ? setConfirmDiscard(true) : onClose())

  return (
    <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
      <DialogContent hideClose className="flex h-[min(88vh,860px)] w-[calc(100vw-32px)] max-w-[1200px] flex-col gap-0 overflow-hidden p-0">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-6 py-4 dark:border-gray-800">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-medium text-gray-900">Teams card</DialogTitle>
            <DialogDescription className="text-sm text-gray-500">Pick and order the parts of the card. The preview shows sample data, never your tenant's policies.</DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <div role="tablist" aria-label="Layout for" className="flex flex-wrap gap-1 rounded-full bg-gray-100 p-1 dark:bg-gray-900">
              {(["base", ...EVENT_GROUP_IDS] as Tab[]).map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry}
                  title={entry === "base" ? "Used by every event without its own layout" : TAB_HINTS[entry]}
                  onClick={() => setTab(entry)}
                  className={`relative rounded-full px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-2 ${tab === entry ? "bg-white font-medium text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white" : "text-gray-600 hover:text-gray-900 dark:text-gray-300"}`}
                >
                  {TAB_LABELS[entry]}
                  {entry !== "base" && layout.overrides[entry] && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-coral-600" aria-label="has its own layout" />}
                </button>
              ))}
            </div>
            <button type="button" onClick={requestClose} className="flex size-9 items-center justify-center rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2 dark:bg-gray-800 dark:text-gray-200" aria-label="Close">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[340px_minmax(0,1fr)] lg:grid-cols-[288px_312px_minmax(0,1fr)]">
          <aside className="min-h-0 space-y-5 overflow-y-auto border-b border-gray-100 p-5 md:border-b-0 md:border-r lg:contents dark:border-gray-800" aria-label="Card parts and settings">
            <div className="space-y-4 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-gray-100 lg:p-5 dark:lg:border-gray-800">
            {tab !== "base" && (
              <div className="rounded-2xl bg-gray-50 p-3 text-sm dark:bg-gray-900">
                {usesDefault ? (
                  <div className="space-y-2">
                    <p className="text-gray-700">{TAB_LABELS[tab]} use the default layout.</p>
                    <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={customizeGroup}>Customize {TAB_LABELS[tab].toLowerCase()}</Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-gray-700">Own layout for {TAB_LABELS[tab].toLowerCase()}</span>
                    <Button type="button" size="sm" variant="ghost" disabled={readOnly} onClick={useDefaultForGroup}>Use default again</Button>
                  </div>
                )}
              </div>
            )}
            <BlockList style={style} selected={selected} onSelect={setSelected} disabled={readOnly || usesDefault} onChange={setStyle} />
            </div>
            <section aria-labelledby="card-block-settings" className="space-y-3 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-gray-100 lg:p-5 dark:lg:border-gray-800">
              <h4 id="card-block-settings" className="flex items-center gap-2 text-sm font-medium text-gray-900">
                {(() => { const Icon = BLOCKS[selected].icon; return <Icon className="h-4 w-4 text-gray-500" aria-hidden="true" /> })()}
                {BLOCKS[selected].label}
              </h4>
              <fieldset disabled={readOnly || usesDefault} className="space-y-3 disabled:opacity-60">
                <BlockSettings block={selected} style={style} tab={tab} theme={theme} onChange={setStyle} issues={issues} />
              </fieldset>
            </section>
          </aside>

          <section className="flex min-h-0 flex-col bg-gray-50 dark:bg-gray-950" aria-label="Preview">
            <div className="flex flex-wrap items-center justify-between gap-2 px-6 pt-5">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                Sample
                <select className="h-8 rounded-full border border-gray-200 bg-white px-3 text-sm dark:bg-input/30" value={sample.id} onChange={(event) => setSampleId(event.target.value)}>
                  {samples.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                </select>
              </label>
              <Segmented
                label="Preview theme"
                value={theme}
                onChange={(next) => setTheme(next as PreviewTheme)}
                options={[{ value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }]}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="mx-auto max-w-[560px]">
                <CardPreview card={cardOf(payload)} theme={theme} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-6 py-3 text-xs text-gray-500 dark:border-gray-800">
              <Chip tone="neutral">Adaptive Card 1.4</Chip>
              <Chip tone="neutral">{(bytes / 1024).toFixed(1)} KB of 28 KB</Chip>
              {fitted.shortened && <Chip tone="warning">Shortened to fit the Teams size limit</Chip>}
              <Chip tone="success">The Azure watcher builds the same card</Chip>
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-6 py-3 dark:border-gray-800">
          {confirmDiscard ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2" role="alertdialog" aria-label="Discard changes">
              <span className="text-sm text-gray-700">Discard the changes to this card?</span>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
                <Button type="button" variant="destructive" onClick={onClose}>Discard</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" size="sm" disabled={readOnly || isDefaultLayout(layout)} onClick={() => setLayout(DEFAULT_CARD_LAYOUT)}><RotateCcw className="h-4 w-4" aria-hidden="true" />Reset to standard</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => void copyForWatcher()}><Copy className="h-4 w-4" aria-hidden="true" />Copy for Azure watcher</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {channels.length > 0 && (
                  <div className="flex items-center gap-1 rounded-full border border-gray-200 p-0.5 dark:border-gray-700">
                    {channels.length > 1 && (
                      <select aria-label="Teams channel for the test" className="h-7 rounded-full bg-transparent px-2 text-sm" value={testChannelId} onChange={(event) => setTestChannelId(event.target.value)}>
                        {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title}</option>)}
                      </select>
                    )}
                    <Button type="button" size="sm" variant="ghost" disabled={readOnly || test.isPending || allIssues.length > 0} onClick={() => test.mutate()}>
                      <Send className="h-4 w-4" aria-hidden="true" />{test.isPending ? "Sending" : channels.length === 1 ? `Send test to ${channels[0]!.title}` : "Send test"}
                    </Button>
                  </div>
                )}
                <Button type="button" variant="outline" onClick={requestClose}>{readOnly ? "Close" : "Cancel"}</Button>
                {!readOnly && <Button type="button" disabled={!dirty || save.isPending || allIssues.length > 0} onClick={() => save.mutate()}>{save.isPending ? "Saving" : "Save card"}</Button>}
              </div>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}

/** Header first, the movable parts in their order, the button last. Drag, or use the arrows. */
function BlockList({ style, selected, onSelect, disabled, onChange }: { style: CardStyle; selected: Selection; onSelect: (block: Selection) => void; disabled: boolean; onChange: (patch: Partial<CardStyle>) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const move = (block: MovableBlock, to: number) => {
    const from = style.order.indexOf(block)
    if (to < 0 || to >= style.order.length || from === to) return
    onChange({ order: arrayMove(style.order, from, to) })
  }
  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return
    move(event.active.id as MovableBlock, style.order.indexOf(event.over.id as MovableBlock))
  }
  const name = (id: string | number) => BLOCKS[id as Selection]?.label ?? String(id)
  const position = (id: string | number) => style.order.indexOf(id as MovableBlock) + 1
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}, position ${position(active.id)} of ${style.order.length}.`,
    onDragOver: ({ active, over }) => (over ? `${name(active.id)} is over position ${position(over.id)} of ${style.order.length}.` : `${name(active.id)} is no longer over a position.`),
    onDragEnd: ({ active, over }) => (over ? `${name(active.id)} dropped at position ${position(over.id)} of ${style.order.length}.` : `${name(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled.`,
  }
  const toggle = (block: HideableBlock) => onChange({ hidden: style.hidden.includes(block) ? style.hidden.filter((entry) => entry !== block) : [...style.hidden, block] })

  return (
    <section aria-labelledby="card-blocks-heading" className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h4 id="card-blocks-heading" className="text-sm font-medium text-gray-900">Parts of the card</h4>
        <span className="text-xs text-gray-500">Drag to reorder</span>
      </div>
      <ul className="space-y-1.5" role="list">
        <PinnedRow block="card" selected={selected === "card"} onSelect={() => onSelect("card")} />
        <PinnedRow block="header" selected={selected === "header"} onSelect={() => onSelect("header")} />
      </ul>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: { draggable: "To move a part, press space, use the arrow keys, then press space again to drop it, or escape to cancel." } }}>
        <SortableContext items={style.order} strategy={verticalListSortingStrategy} disabled={disabled}>
          <ul className="space-y-1.5" role="list">
            {style.order.map((block, index) => (
              <SortableRow
                key={block}
                block={block}
                index={index}
                count={style.order.length}
                hidden={style.hidden.includes(block)}
                selected={selected === block}
                disabled={disabled}
                onSelect={() => onSelect(block)}
                onToggle={() => toggle(block)}
                onMove={(to) => move(block, to)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <ul className="space-y-1.5" role="list">
        <PinnedRow block="button" selected={selected === "button"} onSelect={() => onSelect("button")} hidden={style.hidden.includes("button")} onToggle={disabled ? undefined : () => toggle("button")} />
      </ul>
    </section>
  )
}

const rowClass = (selected: boolean, hidden = false) =>
  `group flex items-center gap-2 rounded-2xl border px-2.5 py-2 transition-colors ${selected ? "border-gray-900 bg-white shadow-sm dark:border-gray-200 dark:bg-gray-900" : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-gray-700"} ${hidden ? "opacity-55" : ""}`

function RowLabel({ block, onSelect }: { block: Selection; onSelect: () => void }) {
  const Icon = BLOCKS[block].icon
  return (
    <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-0.5 text-left focus-visible:outline focus-visible:outline-2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" aria-hidden="true"><Icon className="h-4 w-4" /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-gray-900">{BLOCKS[block].label}</span>
        <span className="block truncate text-xs text-gray-500">{BLOCKS[block].hint}</span>
      </span>
    </button>
  )
}

function VisibilityToggle({ label, hidden, onToggle }: { label: string; hidden: boolean; onToggle?: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!hidden}
      aria-label={`Show ${label}`}
      disabled={!onToggle}
      onClick={onToggle}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline focus-visible:outline-2 disabled:opacity-40 dark:hover:bg-gray-800 dark:hover:text-white"
    >
      {hidden ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
    </button>
  )
}

function PinnedRow({ block, selected, onSelect, hidden = false, onToggle }: { block: Selection; selected: boolean; onSelect: () => void; hidden?: boolean; onToggle?: () => void }) {
  return (
    <li className={rowClass(selected, hidden)}>
      <span className="flex size-6 shrink-0 items-center justify-center text-gray-400" title={block === "card" ? "Applies to the whole card" : "Fixed position"} aria-hidden="true">
        {block === "card" ? <Palette className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
      </span>
      <RowLabel block={block} onSelect={onSelect} />
      {block === "button" && <VisibilityToggle label={BLOCKS[block].label} hidden={hidden} onToggle={onToggle} />}
    </li>
  )
}

function SortableRow({ block, index, count, hidden, selected, disabled, onSelect, onToggle, onMove }: { block: MovableBlock; index: number; count: number; hidden: boolean; selected: boolean; disabled: boolean; onSelect: () => void; onToggle: () => void; onMove: (to: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: block, disabled })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <li ref={setNodeRef} style={style} className={`${rowClass(selected, hidden)} ${isDragging ? "relative z-10 shadow-lg ring-2 ring-coral-600/40" : ""} motion-reduce:transition-none`}>
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Move ${BLOCKS[block].label}, position ${index + 1} of ${count}`}
        disabled={disabled}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 focus-visible:outline focus-visible:outline-2 active:cursor-grabbing disabled:cursor-default disabled:opacity-40 dark:hover:text-gray-200"
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <RowLabel block={block} onSelect={onSelect} />
      {/* Out of the layout until the row is hovered or a button in it has focus, so names keep their room. */}
      <div className="sr-only flex shrink-0 items-center focus-within:not-sr-only group-hover:not-sr-only">
        <button type="button" aria-label={`Move ${BLOCKS[block].label} up`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)} className="flex size-7 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800"><ChevronUp className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" aria-label={`Move ${BLOCKS[block].label} down`} disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)} className="flex size-7 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800"><ChevronDown className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      <VisibilityToggle label={BLOCKS[block].label} hidden={hidden} onToggle={disabled ? undefined : onToggle} />
    </li>
  )
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string; icon?: typeof Sun }>; onChange: (value: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-full bg-gray-100 p-1 dark:bg-gray-900">
      {options.map((option) => {
        const Icon = option.icon
        const on = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 ${on ? "bg-white font-medium text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white" : "text-gray-600 hover:text-gray-900 dark:text-gray-300"}`}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm text-gray-700">{label}</div>
      {children}
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-gray-700">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 ${checked ? "bg-gray-900 dark:bg-white" : "bg-gray-300 dark:bg-gray-700"}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform motion-reduce:transition-none dark:bg-gray-900 ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
        <span className="sr-only">{label}</span>
      </button>
    </label>
  )
}

/** A text with placeholders: chips insert one, and unknown names are reported below. */
function PlaceholderText({ id, value, max, multiline, placeholder, onChange, issue }: { id: string; value: string; max: number; multiline?: boolean; placeholder?: string; onChange: (next: string) => void; issue?: string }) {
  const common = { id, value, maxLength: max, placeholder, "aria-invalid": issue ? true : undefined, "aria-describedby": `${id}-help`, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }
  return (
    <div className="space-y-1.5">
      {multiline ? (
        <textarea {...common} rows={3} className="w-full resize-y rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-red-500 dark:border-gray-700 dark:bg-input/30" />
      ) : (
        <Input {...common} />
      )}
      <div className="flex flex-wrap items-center gap-1" id={`${id}-help`}>
        {PLACEHOLDERS.map((name) => (
          <button key={name} type="button" onClick={() => onChange(`${value}{${name}}`.slice(0, max))} className="rounded-full border border-gray-200 px-2 py-0.5 font-mono text-[11px] text-gray-600 hover:border-gray-400 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300" aria-label={`Insert placeholder ${name}`}>
            {`{${name}}`}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-gray-400">{value.length}/{max}</span>
      </div>
      {issue && <p className="text-xs text-red-700" role="alert">{issue}</p>}
    </div>
  )
}

const ACCENTS: Array<{ value: CardStyle["accent"]; label: string; swatch: Record<PreviewTheme, string> }> = [
  { value: "severity", label: "By severity", swatch: { light: "linear-gradient(90deg,#fdf3f4 0 33%,#fbf6d9 33% 66%,#f5f5f5 66%)", dark: "linear-gradient(90deg,#3e1f25 0 33%,#463100 33% 66%,#333 66%)" } },
  { value: "accent", label: "Accent", swatch: { light: "#e8ebfa", dark: "#2f2f4a" } },
  { value: "emphasis", label: "Neutral", swatch: { light: "#f5f5f5", dark: "#333333" } },
  { value: "good", label: "Green", swatch: { light: "#e7f2da", dark: "#0d2e0d" } },
]

function BlockSettings({ block, style, tab, theme, onChange, issues }: { block: Selection; style: CardStyle; tab: Tab; theme: PreviewTheme; onChange: (patch: Partial<CardStyle>) => void; issues: ReturnType<typeof styleIssues> }) {
  const issueFor = (field: keyof CardStyle) => issues.find((issue) => issue.field === field)?.message
  if (block === "card") {
    return (
      <>
        <Field label="Header color">
          <div role="radiogroup" aria-label="Header color" className="grid grid-cols-2 gap-2">
            {ACCENTS.map((accent) => (
              <button key={accent.value} type="button" role="radio" aria-checked={style.accent === accent.value} onClick={() => onChange({ accent: accent.value })} className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 ${style.accent === accent.value ? "border-gray-900 dark:border-gray-200" : "border-gray-200 hover:border-gray-300 dark:border-gray-700"}`}>
                <span className="h-5 w-8 shrink-0 rounded-md border border-black/5" style={{ background: accent.swatch[theme] }} aria-hidden="true" />
                {accent.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Density"><Segmented label="Density" value={style.density} onChange={(value) => onChange({ density: value as CardStyle["density"] })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} /></Field>
        <Field label="Times" hint="Readable is 2026-11-05 08:42 UTC; ISO is the raw timestamp."><Segmented label="Times" value={style.timeFormat} onChange={(value) => onChange({ timeFormat: value as CardStyle["timeFormat"] })} options={[{ value: "friendly", label: "Readable" }, { value: "iso", label: "ISO" }]} /></Field>
      </>
    )
  }
  if (block === "header") {
    return (
      <>
        <Field label="Show severity as">
          <Segmented label="Show severity as" value={style.severityStyle} onChange={(value) => onChange({ severityStyle: value as CardStyle["severityStyle"] })} options={[{ value: "both", label: "Color and label" }, { value: "tint", label: "Color" }, { value: "label", label: "Label" }]} />
        </Field>
        <Field label="Title prefix" hint="Put before every title, for example [Production].">
          <PlaceholderText id="card-title-prefix" value={style.titlePrefix} max={TEXT_LIMITS.titlePrefix} placeholder="[Production]" onChange={(titlePrefix) => onChange({ titlePrefix })} issue={issueFor("titlePrefix")} />
        </Field>
      </>
    )
  }
  if (block === "summary") {
    return (
      <Field label="Summary text" hint="Leave empty for the summary TenuVault writes for each event.">
        <PlaceholderText id="card-summary" multiline value={style.summaryText} max={TEXT_LIMITS.summaryText} placeholder="Generated for each event" onChange={(summaryText) => onChange({ summaryText })} issue={issueFor("summaryText")} />
      </Field>
    )
  }
  if (block === "details") {
    const labels = [...new Set([...detailLabelsFor(tab), ...style.hiddenDetails])]
    return (
      <Field label="Rows to show" hint={tab === "base" ? "Rows of every event type. Pick a tab above to see one type's rows." : undefined}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {labels.map((label) => (
            <label key={label} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" className="size-4 accent-coral-600" checked={!style.hiddenDetails.includes(label)} onChange={(event) => onChange({ hiddenDetails: event.target.checked ? style.hiddenDetails.filter((entry) => entry !== label) : [...style.hiddenDetails, label] })} />
              {label}
            </label>
          ))}
        </div>
      </Field>
    )
  }
  if (block === "items") {
    return (
      <>
        <Field label="Lines shown" hint="The rest becomes one line: And 9 more.">
          <Segmented label="Lines shown" value={String(style.maxItems)} onChange={(value) => onChange({ maxItems: Number(value) as CardStyle["maxItems"] })} options={[3, 5, 10, 20].map((count) => ({ value: String(count), label: String(count) }))} />
        </Field>
        <Field label="Style">
          <Segmented label="Line style" value={style.itemStyle} onChange={(value) => onChange({ itemStyle: value as CardStyle["itemStyle"] })} options={[{ value: "line", label: "One line" }, { value: "stacked", label: "Name, then details" }]} />
        </Field>
        <div className="space-y-2 rounded-2xl border border-gray-200 p-3 dark:border-gray-800">
          <Toggle label="Type or detail" checked={style.itemDetail} onChange={(itemDetail) => onChange({ itemDetail })} />
          <Toggle label="Who made the change" checked={style.itemActor} onChange={(itemActor) => onChange({ itemActor })} />
          <Toggle label="Time" checked={style.itemTime} onChange={(itemTime) => onChange({ itemTime })} />
        </div>
        <p className="text-xs text-gray-500">Who made a change only shows when change watching includes the actor; that setting stays off by default.</p>
      </>
    )
  }
  if (block === "note") {
    return (
      <>
        <Field label="Note text" hint="Shown in a shaded box. Turn the part on with the eye in the list.">
          <PlaceholderText id="card-note" multiline value={style.noteText} max={TEXT_LIMITS.noteText} placeholder="Call the on-call admin at extension 4411" onChange={(noteText) => onChange({ noteText })} issue={issueFor("noteText")} />
        </Field>
        <Field label="Show for">
          <Segmented label="Show the note for" value={style.noteMinSeverity} onChange={(value) => onChange({ noteMinSeverity: value as NotificationSeverity })} options={[{ value: "info", label: "Every event" }, { value: "warning", label: "Warning and up" }, { value: "critical", label: "Critical only" }]} />
        </Field>
      </>
    )
  }
  if (block === "footer") {
    return (
      <div className="space-y-2 rounded-2xl border border-gray-200 p-3 dark:border-gray-800">
        <Toggle label="Sender (TenuVault desktop or Azure watcher)" checked={style.footerSource} onChange={(footerSource) => onChange({ footerSource })} />
        <Toggle label="Time" checked={style.footerTime} onChange={(footerTime) => onChange({ footerTime })} />
        <Toggle label="Event id" checked={style.footerEventId} onChange={(footerEventId) => onChange({ footerEventId })} />
      </div>
    )
  }
  return (
    <>
      <Field label="Opens" hint="Buttons only open these Microsoft pages, never addresses from tenant data.">
        <select className="h-9 w-full rounded-full border border-gray-200 bg-white px-3 text-sm dark:border-gray-700 dark:bg-input/30" value={style.buttonDestination} onChange={(event) => onChange({ buttonDestination: event.target.value as CardStyle["buttonDestination"] })}>
          <option value="auto">Matching admin center (Intune or Entra changes only)</option>
          <option value="intune">Intune admin center, on every card</option>
          <option value="entra">Conditional Access in Entra, on every card</option>
        </select>
      </Field>
      <Field label="Button label" hint="Leave empty for the standard label.">
        <PlaceholderText id="card-button-label" value={style.buttonLabel} max={TEXT_LIMITS.buttonLabel} placeholder="Open the Intune admin center" onChange={(buttonLabel) => onChange({ buttonLabel })} issue={issueFor("buttonLabel")} />
      </Field>
    </>
  )
}

