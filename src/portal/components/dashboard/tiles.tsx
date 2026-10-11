import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "~/lib/utils"

/** A borderless white bento tile. `focal` is the single dark accent tile of a view. */
export function Tile({
  className,
  focal = false,
  children,
  ...props
}: React.ComponentProps<"section"> & { focal?: boolean }) {
  return (
    <section
      className={cn(
        "relative flex min-w-0 flex-col rounded-3xl p-6",
        focal ? "tv-focal-tile bg-gray-900 text-white" : "bg-white",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  )
}

/** Small muted label above a big value. */
export function TileLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-gray-500", className)}>{children}</p>
}

/** Large light number or phrase, the main value of a tile. */
export function BigValue({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-3xl font-light tracking-tight text-gray-900 tabular-nums", className)}>{children}</p>
}

type Tone = "neutral" | "coral" | "success" | "warning" | "danger"

const toneClasses: Record<Tone, string> = {
  neutral: "bg-gray-100 text-gray-700",
  coral: "bg-blue-50 text-blue-700",
  success: "bg-green-50 text-green-700",
  warning: "bg-amber-50 text-amber-800",
  danger: "bg-red-50 text-red-700",
}

const dotClasses: Record<Tone, string> = {
  neutral: "bg-gray-400",
  coral: "bg-coral-500",
  success: "bg-green-600",
  warning: "bg-amber-500",
  danger: "bg-red-600",
}

/** Pill status chip with a leading dot. */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium", toneClasses[tone])}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", dotClasses[tone])} />
      {children}
    </span>
  )
}

/** Round icon button for tile corners. */
export function RoundIconButton({
  icon: Icon,
  label,
  onClick,
  className,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 transition-colors hover:bg-gray-50",
        className,
      )}
    >
      <Icon className="size-4" />
    </button>
  )
}

/** Round icon badge, the tile's identifying glyph in the top left corner. */
export function TileIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700", className)}>
      <Icon className="size-4" />
    </span>
  )
}

/**
 * Progress ring. `value` is a percentage, or null for no data (only the track is drawn).
 * `marker` draws a tick at a target percentage.
 */
export function Ring({
  value,
  marker,
  size = 148,
  stroke = 12,
  children,
}: {
  value: number | null
  marker?: number
  size?: number
  stroke?: number
  children?: ReactNode
}) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = value === null ? 0 : Math.max(0, Math.min(100, value))
  const markerAngle = marker === undefined || value === null ? null : (marker / 100) * 2 * Math.PI - Math.PI / 2
  const c = size / 2
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={c} cy={c} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={stroke} />
        {value !== null && clamped > 0 && (
          <circle
            cx={c}
            cy={c}
            r={radius}
            fill="none"
            className="tv-ring-value"
            stroke="var(--color-coral-500)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
        {markerAngle !== null && (
          <line
            x1={c + (radius - stroke / 2 - 3) * Math.cos(markerAngle)}
            y1={c + (radius - stroke / 2 - 3) * Math.sin(markerAngle)}
            x2={c + (radius + stroke / 2 + 3) * Math.cos(markerAngle)}
            y2={c + (radius + stroke / 2 + 3) * Math.sin(markerAngle)}
            stroke="currentColor"
            strokeOpacity={0.7}
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  )
}

/** Horizontal bars in coral tints, scaled to the largest value. */
export function BarList({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((item) => item.value))
  const tints = ["bg-coral-500", "bg-coral-400", "bg-coral-300", "bg-coral-200", "bg-coral-100"]
  return (
    <ul className="space-y-3.5">
      {items.map((item, index) => (
        <li key={item.label}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-gray-600">{item.label}</span>
            <span className="font-medium text-gray-900 tabular-nums">{item.value}</span>
          </div>
          <div className="tv-bar-track h-2.5 overflow-hidden rounded-full bg-gray-100">
            <div
              className={cn("h-full rounded-full", tints[index % tints.length])}
              style={{ width: item.value > 0 ? `${Math.max(3, (item.value / max) * 100)}%` : "0%" }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Label and value pair for fact lists. */
export function Fact({ label, children, wrap = false }: { label: string; children: ReactNode; wrap?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={cn("mt-0.5 text-sm font-medium text-gray-900", !wrap && "truncate")}>{children}</dd>
    </div>
  )
}
