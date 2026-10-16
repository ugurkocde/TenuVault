import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Info, X } from "lucide-react"
import { cn } from "~/lib/utils"
import type { ReportPayload } from "../../../shared/oib/report"
import { bridge } from "../../lib/bridge"
import { errorText } from "./common"

/** What an export did: saved (with the path when the save dialog returns one), cancelled or failed. */
export interface SaveResult {
  saved: boolean
  fileName: string
  path?: string
  error?: string
}

const saved = (result: { saved: boolean; path?: string }, name: string): SaveResult =>
  result.saved ? { saved: true, fileName: result.path?.split(/[\\/]/).pop() ?? name, path: result.path } : { saved: false, fileName: name }

/**
 * Asks where to save an export (native Save dialog) and writes it. The extension of `fileName`
 * picks the format: CSV, JSON or text as UTF-8, a PDF as base64. Never rejects.
 */
export async function saveFile(data: string, fileName: string, encoding: "utf8" | "base64" = "utf8"): Promise<SaveResult> {
  try {
    return saved(await bridge.reports.saveFile(data, fileName, encoding), fileName)
  } catch (error) {
    return { saved: false, fileName, error: errorText(error, `${fileName} could not be saved.`) }
  }
}

/** Saves a CSV or JSON export through the Save dialog; `type` is kept for callers of the former download. */
export const saveText = (content: string, fileName: string, _type?: string): Promise<SaveResult> => saveFile(content, fileName)

/** Has the main process generate a report PDF and asks where to save it; resolves with the outcome, never rejects. */
export async function savePdf(report: ReportPayload, fileName: string): Promise<SaveResult> {
  const name = fileName.endsWith(".pdf") ? fileName : `${fileName}.pdf`
  try {
    return saved(await bridge.reports.savePdf(report, name), name)
  } catch (error) {
    return { saved: false, fileName: name, error: errorText(error, "The PDF could not be saved.") }
  }
}

/** "Saved <file>" with its path, "Nothing was saved" when cancelled, or the error. */
export function Notice({ result, onDismiss, className }: { result: SaveResult | null; onDismiss?: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  // A notice drawn under a button near the window edge would go unseen; bring it into view (no effect when it is already visible).
  useEffect(() => { if (result) ref.current?.scrollIntoView({ block: "nearest" }) }, [result])
  if (!result) return null
  const Icon = result.saved ? CheckCircle2 : Info
  return <div ref={ref} role={result.error ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-2xl px-4 py-3 text-sm", result.error ? "bg-red-50 text-red-800" : result.saved ? "bg-green-50 text-green-900" : "bg-gray-50 text-gray-800", className)}>
    <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p>{result.error ? result.error : result.saved ? <>{result.path ? "Saved" : "Exported"} <strong className="font-medium">{result.fileName}</strong>.</> : "Nothing was saved."}</p>
      {result.path && <p className="mt-0.5 break-all text-xs opacity-80">{result.path}</p>}
    </div>
    {onDismiss && <button type="button" onClick={onDismiss} className="rounded-full p-0.5 opacity-70 hover:opacity-100" aria-label="Dismiss"><X className="h-4 w-4" aria-hidden="true" /></button>}
  </div>
}

/** The latest export result and a busy flag, for a <Notice> next to the export buttons. */
export function useSaveNotice() {
  const [result, setResult] = useState<SaveResult | null>(null)
  const [saving, setSaving] = useState(false)
  return {
    result,
    saving,
    clear: () => setResult(null),
    /** Runs an export (saveFile, saveText or savePdf) and keeps its result for the notice. */
    async save(action: () => SaveResult | Promise<SaveResult>) {
      setSaving(true); setResult(null)
      try { setResult(await action()) } catch (error) { setResult({ saved: false, fileName: "", error: errorText(error, "The export failed.") }) } finally { setSaving(false) }
    },
  }
}
