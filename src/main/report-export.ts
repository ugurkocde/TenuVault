import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindowConstructorOptions } from "electron"
import { parseReportPayload } from "../shared/oib/report"
import { buildOibReport, type OibPrintOptions } from "../shared/oib/report-html"
import { pdfBrandingFor } from "./pdf-branding"
import { prepareSaveFile, type PreparedFile } from "./save-file"

/** The hidden window an OIB report prints in: sandboxed, isolated, without Node or JavaScript. */
export const REPORT_WINDOW: BrowserWindowConstructorOptions = {
  show: false,
  webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
}

/** The part of an Electron BrowserWindow the report printing uses. */
export interface ReportWindow {
  webContents: {
    setWindowOpenHandler(handler: () => { action: "deny" }): void
    on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): unknown
    printToPDF(options: OibPrintOptions): Promise<Uint8Array>
  }
  loadFile(path: string): Promise<void>
  destroy(): void
}

/** Prints HTML to PDF bytes; printHtmlToPdf with a real BrowserWindow in the app. */
export type HtmlPrinter = (html: string, options: OibPrintOptions) => Promise<Uint8Array>

/**
 * Prints a report document in a hidden window made by `open` (REPORT_WINDOW options): new windows
 * and navigation are denied, the HTML is written to a private temporary folder as a 0600 file and
 * loaded from there, and the window and folder are removed afterwards, also on failure.
 */
export async function printHtmlToPdf(html: string, options: OibPrintOptions, open: (options: BrowserWindowConstructorOptions) => ReportWindow): Promise<Uint8Array> {
  const folder = await mkdtemp(join(tmpdir(), "tenuvault-report-"))
  let page: ReportWindow | undefined
  try {
    page = open(REPORT_WINDOW)
    page.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    page.webContents.on("will-navigate", (event) => event.preventDefault())
    const file = join(folder, "report.html")
    await writeFile(file, html, { encoding: "utf8", mode: 0o600 })
    await page.loadFile(file)
    return await page.webContents.printToPDF(options)
  } finally {
    page?.destroy()
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Turns an OpenIntuneBaseline report sent by the renderer into a PDF file ready for the Save dialog:
 * the payload is checked strictly, the branding follows the plan of the report's tenant, the HTML is
 * built here, in the main process, and printed with `print`. The result must be a PDF.
 */
export async function prepareOibReportFile(payload: unknown, fileName: unknown, print: HtmlPrinter, exportedAt = new Date().toISOString()): Promise<PreparedFile> {
  const report = parseReportPayload(payload)
  const branding = await pdfBrandingFor(report.tenantId)
  const document = buildOibReport(report, { exportedAt, branding })
  const pdf = await print(document.html, document.print)
  const base = (typeof fileName === "string" ? fileName : "").replace(/\.pdf$/i, "").trim() || "TenuVault report"
  return prepareSaveFile(Buffer.from(pdf).toString("base64"), `${base}.pdf`, "base64")
}
