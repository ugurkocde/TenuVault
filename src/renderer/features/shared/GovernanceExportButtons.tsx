import { Download } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Notice, saveText, useSaveNotice } from "../../components/oib/notices"
import { governanceExportName, type GovernanceExportKind } from "./governance-export"

/**
 * CSV and JSON export buttons for a governance tab, saved through the native Save
 * dialog like the OIB exports. Disabled when there is nothing to export, matching
 * the drift export; the notice reports where the file went.
 */
export function GovernanceExportButtons({ kind, tenantName, disabled, buildCsv, buildJson }: {
  kind: GovernanceExportKind
  tenantName: string | null
  disabled: boolean
  buildCsv: () => string
  buildJson: (exportedAt: string) => string
}) {
  const notice = useSaveNotice()
  const exportAs = (format: "csv" | "json") => {
    const exportedAt = new Date().toISOString()
    const name = governanceExportName(kind, tenantName, exportedAt)
    void notice.save(() => saveText(format === "csv" ? `\ufeff${buildCsv()}` : buildJson(exportedAt), `${name}.${format}`))
  }
  return (
    <span className="inline-flex flex-col items-start gap-2">
      <span className="inline-flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled || notice.saving} onClick={() => exportAs("csv")}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Export CSV
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || notice.saving} onClick={() => exportAs("json")}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Export JSON
        </Button>
      </span>
      <Notice result={notice.result} onDismiss={notice.clear} />
    </span>
  )
}
