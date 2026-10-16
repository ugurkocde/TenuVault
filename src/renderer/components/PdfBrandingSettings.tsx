import { useEffect, useId, useRef, useState, type ChangeEvent } from "react"
import { ImagePlus, Loader2, Palette, RotateCcw, Save, Trash2 } from "lucide-react"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { allows } from "../../shared/plans"
import { luminance, parseHexColor, type PdfBranding } from "../../shared/pdf/theme"
import { bridge } from "../lib/bridge"
import { tenantPlan, useLicense } from "../lib/license"
import { showFeaturePlanError } from "../lib/plan-dialog"
import { toast } from "../lib/toast"
import { PlanBadge, UpgradeNote } from "./UpgradeNote"

/** The TenuVault charcoal and coral, the starting colors of a new branding. */
const DEFAULT_PRIMARY = "#161514"
const DEFAULT_ACCENT = "#E4674B"
const LOGO_LIMIT = 1024 * 1024
const HEX = /^#[0-9a-fA-F]{6}$/

interface Form {
  companyName: string
  logo?: string
  primary: string
  accent: string
  preparedBy: string
  classification: string
  footerText: string
}

const toForm = (branding: PdfBranding | null): Form => ({
  companyName: branding?.companyName ?? "",
  logo: branding?.logo?.dataUrl,
  primary: branding?.colors?.primary ?? DEFAULT_PRIMARY,
  accent: branding?.colors?.accent ?? DEFAULT_ACCENT,
  preparedBy: branding?.preparedBy ?? "",
  classification: branding?.classification ?? "",
  footerText: branding?.footerText ?? "",
})

const toBranding = (form: Form): PdfBranding => ({
  companyName: form.companyName.trim(),
  ...(form.logo && { logo: { dataUrl: form.logo } }),
  colors: { primary: form.primary.toUpperCase(), accent: form.accent.toUpperCase() },
  ...(form.preparedBy.trim() && { preparedBy: form.preparedBy.trim() }),
  ...(form.classification.trim() && { classification: form.classification.trim() }),
  ...(form.footerText.trim() && { footerText: form.footerText.trim() }),
})

/** Reads a PNG or JPEG of at most 1 MB as a data URL; rejects with a message for anything else. */
export function readLogo(file: File): Promise<string> {
  if (file.type !== "image/png" && file.type !== "image/jpeg") return Promise.reject(new Error("Choose a PNG or JPEG image."))
  if (file.size > LOGO_LIMIT) return Promise.reject(new Error("The logo can be at most 1 MB."))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("The logo could not be read."))
    reader.onerror = () => reject(new Error("The logo could not be read."))
    reader.readAsDataURL(file)
  })
}

function ColorField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId()
  const valid = HEX.test(value)
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-gray-500">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} className="h-10 w-12 shrink-0 cursor-pointer rounded-full border border-gray-200 bg-white p-1 disabled:cursor-not-allowed" value={valid ? value.toLowerCase() : "#000000"} disabled={disabled} onChange={event => onChange(event.target.value.toUpperCase())} />
        <Input id={id} value={value} maxLength={7} spellCheck={false} disabled={disabled} aria-invalid={!valid} className="font-mono uppercase" onChange={event => onChange(event.target.value.trim())} />
      </div>
      {!valid && <p role="alert" className="text-xs text-red-700">Enter a color as #RRGGBB.</p>}
    </div>
  )
}

/** A small HTML mock of the report cover in the chosen colors, so admins see the result before exporting. */
function CoverPreview({ form }: { form: Form }) {
  const primary = parseHexColor(form.primary) ?? parseHexColor(DEFAULT_PRIMARY)!
  const accent = HEX.test(form.accent) ? form.accent : DEFAULT_ACCENT
  const onBand = luminance(primary) > 0.5 ? "#161514" : "#FFFFFF"
  const name = form.companyName.trim() || "Your company"
  return (
    <figure aria-label="Report cover preview" className="w-full max-w-[240px] shrink-0">
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="relative h-[150px] overflow-hidden px-4 py-3" style={{ background: HEX.test(form.primary) ? form.primary : DEFAULT_PRIMARY, color: onBand }}>
          <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute -right-10 -top-8 h-36 w-36 opacity-40">
            <circle cx="50" cy="50" r="40" fill="none" stroke={accent} strokeWidth="9" strokeDasharray="160 252" />
            <circle cx="50" cy="50" r="48" fill="none" stroke={onBand} strokeOpacity="0.2" strokeWidth="0.8" />
          </svg>
          {form.logo
            ? <img src={form.logo} alt="Logo" className="relative max-h-6 max-w-[110px] rounded-sm bg-white/90 object-contain p-0.5" />
            : <p className="relative truncate text-[11px] font-semibold">{name}</p>}
          <div className="relative mt-7 h-1 w-6 rounded-full" style={{ background: accent }} />
          <p className="relative mt-1.5 text-[7px] font-semibold uppercase tracking-wider" style={{ color: accent }}>Configuration comparison</p>
          <p className="relative mt-0.5 text-[15px] font-semibold leading-tight">NIST SP 800-53</p>
          <p className="relative mt-3 text-[7px] uppercase tracking-wider opacity-70">Tenant</p>
          <p className="relative text-[10px] font-semibold">Contoso Ltd</p>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <svg aria-hidden="true" viewBox="0 0 36 36" className="h-10 w-10 shrink-0">
            <circle cx="18" cy="18" r="14" fill="none" stroke="#E4E1DD" strokeWidth="5" />
            <circle cx="18" cy="18" r="14" fill="none" stroke={accent} strokeWidth="5" strokeDasharray="56 88" transform="rotate(-90 18 18)" />
          </svg>
          <div className="min-w-0 flex-1 space-y-1.5">
            {[80, 55, 35].map(width => <div key={width} className="h-1.5 rounded-full bg-gray-100"><div className="h-1.5 rounded-full" style={{ width: `${width}%`, background: accent }} /></div>)}
          </div>
        </div>
        <div className="flex justify-between gap-2 border-t border-gray-100 px-4 py-1.5 text-[7px] text-gray-500">
          <span className="truncate">{form.footerText.trim() || name}</span><span className="shrink-0">Page 1 of 12</span>
        </div>
      </div>
      <figcaption className="mt-2 text-xs text-gray-500">Preview of the cover. Branded reports carry no TenuVault branding.</figcaption>
    </figure>
  )
}

/** Settings > PDF branding: the customer name, logo, colors and labels of every PDF export, on Pro and MSP. */
export function PdfBrandingSettings() {
  const { status } = useLicense()
  const available = !!status?.tenants.some(tenant => {
    const plan = tenantPlan(tenant)
    return plan !== null && allows(plan, "pdfBranding")
  })
  const [saved, setSaved] = useState<PdfBranding | null>(null)
  const [form, setForm] = useState<Form>(() => toForm(null))
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<"save" | "reset" | null>(null)
  const [error, setError] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  const ids = { company: useId(), logo: useId(), preparedBy: useId(), classification: useId(), footer: useId() }

  useEffect(() => {
    bridge.pdfBranding.get().then(state => {
      setSaved(state.branding)
      setForm(toForm(state.branding))
    }).catch(failure => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setLoaded(true))
  }, [])

  const disabled = !available || busy !== null || !loaded
  const set = (changes: Partial<Form>) => { setForm(current => ({ ...current, ...changes })); setError("") }
  const chooseLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    try {
      set({ logo: await readLogo(file) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  const save = async () => {
    if (!form.companyName.trim()) return setError("Enter a company name; branded reports carry it instead of TenuVault.")
    if (!HEX.test(form.primary) || !HEX.test(form.accent)) return setError("Enter both colors as #RRGGBB.")
    setBusy("save")
    try {
      const state = await bridge.pdfBranding.set(toBranding(form))
      setSaved(state.branding)
      setForm(toForm(state.branding))
      toast("PDF branding saved. New PDF exports of Pro and MSP tenants use it.", "success")
    } catch (failure) {
      if (!showFeaturePlanError(failure)) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }
  const reset = async () => {
    setBusy("reset")
    try {
      const state = await bridge.pdfBranding.clear()
      setSaved(state.branding)
      setForm(toForm(null))
      toast("PDF reports use the TenuVault design again.", "success")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="p-7 pb-4">
        <CardTitle className="flex items-center gap-3 text-xl font-medium">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Palette className="h-[18px] w-[18px]" /></span> PDF branding
          {!available && <PlanBadge feature="pdfBranding" />}
        </CardTitle>
        <CardDescription>
          Your company name, logo and colors on every PDF report: framework comparisons, policy pack assessments, CIS readiness and OpenIntuneBaseline reports.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-7 pb-7 text-sm text-gray-700">
        {!available && <UpgradeNote feature="pdfBranding" />}
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={ids.company} className="text-xs font-medium text-gray-500">Company name</label>
              <Input id={ids.company} value={form.companyName} maxLength={120} disabled={disabled} placeholder="Fabrikam Security Services" onChange={event => set({ companyName: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <p id={ids.logo} className="text-xs font-medium text-gray-500">Logo</p>
              <div className="flex flex-wrap items-center gap-3">
                {form.logo && <img src={form.logo} alt="Current logo" className="h-10 max-w-[140px] rounded-lg border border-gray-200 bg-white object-contain p-1" />}
                <input ref={fileInput} type="file" accept="image/png,image/jpeg" className="hidden" aria-labelledby={ids.logo} disabled={disabled} onChange={event => void chooseLogo(event)} />
                <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => fileInput.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />{form.logo ? "Replace logo" : "Upload logo"}</Button>
                {form.logo && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => set({ logo: undefined })}><Trash2 className="mr-2 h-4 w-4" />Remove logo</Button>}
              </div>
              <p className="text-xs text-gray-500">PNG or JPEG, up to 1 MB and 2048 by 2048 pixels. Shown top left on the cover; a wide logo on a transparent background works best.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField label="Primary color" value={form.primary} disabled={disabled} onChange={primary => set({ primary })} />
              <ColorField label="Accent color" value={form.accent} disabled={disabled} onChange={accent => set({ accent })} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor={ids.preparedBy} className="text-xs font-medium text-gray-500">Prepared by</label>
                <Input id={ids.preparedBy} value={form.preparedBy} maxLength={120} disabled={disabled} placeholder="Name or team" onChange={event => set({ preparedBy: event.target.value })} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor={ids.classification} className="text-xs font-medium text-gray-500">Classification</label>
                <Input id={ids.classification} value={form.classification} maxLength={120} disabled={disabled} placeholder="Confidential" onChange={event => set({ classification: event.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={ids.footer} className="text-xs font-medium text-gray-500">Footer text</label>
              <Input id={ids.footer} value={form.footerText} maxLength={120} disabled={disabled} placeholder="Defaults to the company name" onChange={event => set({ footerText: event.target.value })} />
            </div>
          </div>
          <CoverPreview form={form} />
        </div>
        <p className="text-xs text-gray-500">
          Branding applies to PDF reports of tenants on Pro or MSP; reports of Community tenants keep the TenuVault design.
          Branded reports carry no TenuVault name or logo. License and attribution text of framework publishers and
          OpenIntuneBaseline is printed as published.
        </p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={disabled || !form.companyName.trim()} onClick={() => void save()}>
            {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save branding
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy !== null || !saved} onClick={() => void reset()}>
            {busy === "reset" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}Reset to TenuVault design
          </Button>
        </div>
        {saved && !available && <p role="note" className="text-xs text-gray-700">Saved branding for {saved.companyName} is kept but not applied until a tenant is on Pro or MSP.</p>}
      </CardContent>
    </Card>
  )
}
