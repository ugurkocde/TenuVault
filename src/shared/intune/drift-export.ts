import type { Drift, DriftResult } from "./drift"
import { formatValue, settingLabel } from "./drift-format"

/**
 * Drift reports as files: one CSV row per changed setting (added and deleted items get one row
 * without a setting), and JSON with the same rows nested under their items.
 */

/** "drift-contoso-backup-2026-10-06-020000-to-backup-2026-10-07-020000", without an extension. */
export function driftExportName(result: Pick<DriftResult, "baseline" | "comparison">, tenantName?: string): string {
  const slug = (tenantName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, "-")
  return ["drift", slug, `${safe(result.baseline.id)}-to-${safe(result.comparison.id)}`].filter(Boolean).join("-")
}

/** A value as one line of text: readable for scalars and choices, compact JSON for objects. */
function valueText(value: unknown, definitionId: string | undefined, names: DriftResult["settingNames"]): string {
  const formatted = formatValue(value, definitionId, names)
  if (formatted.kind === "empty") return ""
  if (formatted.kind === "json") return JSON.stringify(value)
  return formatted.text
}

function settingRows(drift: Drift, names: DriftResult["settingNames"]) {
  return (drift.changes ?? []).map((change) => {
    const { label, path, definitionId } = settingLabel(change, names)
    return {
      setting: label,
      path,
      before: valueText(change.oldValue, definitionId, names),
      after: valueText(change.newValue, definitionId, names),
      beforeRaw: change.oldValue,
      afterRaw: change.newValue,
    }
  })
}

const CSV_HEADERS = ["Item", "Item type", "Change", "Severity", "Previous name", "Setting", "Setting path", "Before", "After", "Item ID"]

function csvCell(value: string): string {
  // Cells starting with formula characters are prefixed, so spreadsheets show them as text; negative numbers stay numbers.
  const text = /^[=+@\t\r]|^-(?!\d+(?:\.\d+)?$)/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function driftCsv(result: Pick<DriftResult, "drifts" | "settingNames">): string {
  const rows: string[][] = []
  for (const drift of result.drifts) {
    const item = [drift.configName, drift.type, drift.changeType, drift.severity, drift.previousName ?? ""]
    const settings = settingRows(drift, result.settingNames)
    if (settings.length === 0) rows.push([...item, "", "", "", "", drift.configId])
    for (const setting of settings) rows.push([...item, setting.setting, setting.path, setting.before, setting.after, drift.configId])
  }
  return [CSV_HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")
}

export function driftJson(result: DriftResult, tenantName: string | undefined, exportedAt = new Date().toISOString()): string {
  return JSON.stringify({
    exportedAt,
    tenant: tenantName ?? null,
    scannedAt: result.lastScan,
    baseline: result.baseline,
    comparison: result.comparison,
    counts: {
      added: result.drifts.filter((drift) => drift.changeType === "added").length,
      modified: result.drifts.filter((drift) => drift.changeType === "modified").length,
      deleted: result.drifts.filter((drift) => drift.changeType === "deleted").length,
    },
    warnings: result.warnings,
    items: result.drifts.map((drift) => ({
      name: drift.configName,
      ...(drift.previousName ? { previousName: drift.previousName } : {}),
      type: drift.type,
      change: drift.changeType,
      severity: drift.severity,
      id: drift.configId,
      backupFile: drift.backupFile ?? null,
      settings: settingRows(drift, result.settingNames),
    })),
  }, null, 2)
}
