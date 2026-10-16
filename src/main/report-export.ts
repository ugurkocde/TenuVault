import { parseReportPayload } from "../shared/oib/report"
import { pdfBrandingFor } from "./pdf-branding"
import { prepareSaveFile, type PreparedFile } from "./save-file"

/**
 * Turns an OpenIntuneBaseline report sent by the renderer into a PDF file ready for the Save dialog:
 * the payload is checked strictly, the branding follows the plan of the report's tenant and the
 * PDF is generated here, in the main process.
 */
export async function prepareOibReportFile(payload: unknown, fileName: unknown, exportedAt = new Date().toISOString()): Promise<PreparedFile> {
  const report = parseReportPayload(payload)
  const branding = await pdfBrandingFor(report.tenantId)
  const { generateOibReportPDF } = await import("../shared/oib/report-pdf")
  const pdf = generateOibReportPDF(report, { exportedAt, branding })
  const base = (typeof fileName === "string" ? fileName : "").replace(/\.pdf$/i, "").trim() || "TenuVault report"
  return prepareSaveFile(Buffer.from(pdf).toString("base64"), `${base}.pdf`, "base64")
}
