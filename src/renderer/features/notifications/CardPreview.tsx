import type { CSSProperties, ReactNode } from "react"
import { ExternalLink } from "lucide-react"

/**
 * Draws an Adaptive Card the way Teams shows a Workflows post, from the exact JSON the
 * channel receives (teamsWorkflowsPayload). It understands the elements TenuVault's card
 * builder produces (Container, TextBlock, FactSet, Action.OpenUrl) and flags anything else,
 * so the preview can never silently differ from the card. Text is rendered as plain text:
 * the builder's markdown escapes are removed, nothing is interpreted as markup or links.
 */

export type PreviewTheme = "light" | "dark"

interface Palette {
  canvas: string
  card: string
  border: string
  text: string
  subtle: string
  containers: Record<string, string>
  colors: Record<string, string>
  button: { border: string; text: string }
}

/** Close to Teams' own host config for light and dark. */
const PALETTES: Record<PreviewTheme, Palette> = {
  light: {
    canvas: "#f5f5f5",
    card: "#ffffff",
    border: "#e0e0e0",
    text: "#242424",
    subtle: "#616161",
    containers: { default: "transparent", emphasis: "#f5f5f5", accent: "#e8ebfa", good: "#e7f2da", attention: "#fdf3f4", warning: "#fbf6d9" },
    colors: { Default: "#242424", Accent: "#4f52b2", Good: "#237b4b", Warning: "#835c00", Attention: "#c4314b", Light: "#ffffff", Dark: "#242424" },
    button: { border: "#d1d1d1", text: "#242424" },
  },
  dark: {
    canvas: "#1f1f1f",
    card: "#292929",
    border: "#3d3d3d",
    text: "#ffffff",
    subtle: "#adadad",
    containers: { default: "transparent", emphasis: "#333333", accent: "#2f2f4a", good: "#0d2e0d", attention: "#3e1f25", warning: "#463100" },
    colors: { Default: "#ffffff", Accent: "#7f85f5", Good: "#92c353", Warning: "#f8d22a", Attention: "#f9526b", Light: "#ffffff", Dark: "#242424" },
    button: { border: "#5c5c5c", text: "#ffffff" },
  },
}

type Element = Record<string, unknown> & { type?: string }

const SPACING: Record<string, number> = { None: 0, Small: 4, Default: 8, Medium: 16, Large: 24 }

/** Removes the backslash escapes the card builder adds for Teams markdown. */
export function plainCardText(text: string): string {
  return text.replace(/\\(.)/g, "$1")
}

function spacingOf(element: Element, first: boolean): number {
  if (first) return 0
  return SPACING[typeof element.spacing === "string" ? element.spacing : "Default"] ?? 8
}

function TextBlock({ element, palette }: { element: Element; palette: Palette }) {
  const size = element.size === "Small" ? 12 : element.size === "Medium" ? 16 : element.size === "Large" ? 20 : 14
  const color = element.isSubtle ? palette.subtle : palette.colors[typeof element.color === "string" ? element.color : "Default"] ?? palette.text
  const style: CSSProperties = { fontSize: size, lineHeight: 1.4, fontWeight: element.weight === "Bolder" ? 600 : 400, color, whiteSpace: element.wrap ? "pre-wrap" : "nowrap", overflowWrap: "anywhere", overflow: element.wrap ? undefined : "hidden", textOverflow: element.wrap ? undefined : "ellipsis" }
  return <div style={style}>{plainCardText(String(element.text ?? ""))}</div>
}

function FactSet({ element, palette }: { element: Element; palette: Palette }) {
  const facts = Array.isArray(element.facts) ? (element.facts as Array<{ title?: string; value?: string }>) : []
  return (
    <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 12, rowGap: 2, fontSize: 14, lineHeight: 1.4, color: palette.text }}>
      {facts.map((fact, index) => (
        <div key={index} style={{ display: "contents" }}>
          <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{plainCardText(String(fact.title ?? ""))}</div>
          <div style={{ overflowWrap: "anywhere" }}>{plainCardText(String(fact.value ?? ""))}</div>
        </div>
      ))}
    </div>
  )
}

function Elements({ items, palette, inset }: { items: Element[]; palette: Palette; inset: number }): ReactNode {
  return items.map((element, index) => {
    const marginTop = spacingOf(element, index === 0)
    let content: ReactNode
    if (element.type === "TextBlock") content = <TextBlock element={element} palette={palette} />
    else if (element.type === "FactSet") content = <FactSet element={element} palette={palette} />
    else if (element.type === "Container") {
      const style = typeof element.style === "string" ? element.style : "default"
      const tinted = style !== "default"
      const bleed = element.bleed === true
      content = (
        <div
          style={{
            background: palette.containers[style] ?? "transparent",
            padding: tinted ? `${bleed ? 14 : 10}px ${inset}px` : 0,
            margin: bleed ? `0 ${-inset}px` : undefined,
            borderRadius: bleed ? 0 : 6,
          }}
        >
          <Elements items={Array.isArray(element.items) ? (element.items as Element[]) : []} palette={palette} inset={tinted && !bleed ? 10 : inset} />
        </div>
      )
    } else {
      content = <div style={{ border: `1px dashed ${palette.colors.Attention}`, color: palette.colors.Attention, fontSize: 12, padding: 6 }}>Unsupported element: {String(element.type)}</div>
    }
    return (
      <div key={index} style={{ marginTop }}>
        {content}
      </div>
    )
  })
}

/** One Workflows message holding the card, on a Teams-like canvas. */
export function CardPreview({ card, theme, time = "10:04", compact = false }: { card: Record<string, unknown>; theme: PreviewTheme; time?: string; compact?: boolean }) {
  const palette = PALETTES[theme]
  const body = Array.isArray(card.body) ? (card.body as Element[]) : []
  const actions = Array.isArray(card.actions) ? (card.actions as Array<{ title?: string; url?: string }>) : []
  const inset = 16
  return (
    <div style={{ background: palette.canvas, padding: compact ? 12 : 20, borderRadius: 16, fontFamily: "'Segoe UI', 'Segoe UI Web', system-ui, sans-serif" }} aria-label="Teams card preview" role="img">
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div aria-hidden="true" style={{ flex: "none", width: 32, height: 32, borderRadius: 8, background: "#5b5fc7", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14 }}>W</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: palette.text }}>Workflows</span>
            <span style={{ fontSize: 12, color: palette.subtle }}>{time}</span>
          </div>
          <div style={{ maxWidth: 450, background: palette.card, border: `1px solid ${palette.border}`, borderRadius: 8, padding: `0 ${inset}px ${inset}px`, overflow: "hidden", boxShadow: theme === "light" ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}>
            <div style={{ paddingTop: body[0]?.type === "Container" && body[0]?.bleed === true ? 0 : inset }}>
              <Elements items={body} palette={palette} inset={inset} />
            </div>
            {actions.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {actions.map((action, index) => (
                  <span key={index} title={action.url} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${palette.button.border}`, color: palette.button.text, borderRadius: 4, padding: "5px 12px", fontSize: 13, fontWeight: 600 }}>
                    {plainCardText(String(action.title ?? ""))}
                    <ExternalLink size={12} aria-hidden="true" />
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
