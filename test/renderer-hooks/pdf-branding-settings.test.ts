import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LicenseStatus, PdfBrandingState } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pdfBranding = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), clear: vi.fn() }))
const license = vi.hoisted(() => ({ status: null as LicenseStatus | null }))

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { pdfBranding, license: { open: async () => undefined } } }))
vi.mock("../../src/renderer/lib/license", async (original) => ({ ...(await original<typeof import("../../src/renderer/lib/license")>()), useLicense: () => ({ status: license.status, error: null, refresh: async () => undefined }) }))

import { PdfBrandingSettings, readLogo } from "../../src/renderer/components/PdfBrandingSettings"
import { FeatureApiError } from "../../src/renderer/lib/feature-api"
import { closePlanDialog, planDialogError } from "../../src/renderer/lib/plan-dialog"

const TENANT = "11111111-1111-1111-1111-111111111111"
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const SAVED = { companyName: "Fabrikam Security Services", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Avery", logo: { dataUrl: PNG } }

function statusFor(plan: "community" | "pro" | "msp"): LicenseStatus {
  return {
    hasKey: plan !== "community", keyState: plan === "community" ? "none" : "active", keyMessage: null, keyHint: null, persisted: true, offline: false, message: null,
    plan: plan === "community" ? null : plan, tenantLimit: null, validUntil: null, communityTenantId: plan === "community" ? TENANT : null,
    tenants: [{ tenantId: TENANT, signedIn: true, activated: plan !== "community", entitled: plan !== "community", source: plan === "community" ? null : "key", plan, tenants: null, expiresAt: null, validUntil: null, shared: null, shareNeedsSignIn: false, displayKey: null, message: null }],
  }
}

const roots: Root[] = []
const containers: HTMLDivElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.resetAllMocks()
  closePlanDialog()
})

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error("Condition not met in time.")
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }
}

async function render(plan: "community" | "pro" | "msp", state: PdfBrandingState) {
  license.status = statusFor(plan)
  pdfBranding.get.mockResolvedValue(state)
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(PdfBrandingSettings)))
  await flush()
  return container
}

const field = (container: HTMLElement, label: string) => {
  const element = [...container.querySelectorAll("label")].find((item) => item.textContent === label)
  return container.querySelector<HTMLInputElement>(`#${CSS.escape(element!.htmlFor)}`)!
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function click(target: HTMLElement) {
  await act(async () => target.click())
  await flush()
}

describe("Settings PDF branding section", () => {
  it("shows the plan badge and upgrade note on Community with every field disabled", async () => {
    const container = await render("community", { branding: null, available: false })
    expect(container.textContent).toContain("PDF branding")
    expect(container.textContent).toContain("Pro")
    expect(container.textContent).toContain("Full white-label PDF reports with your logo and colors: included in TenuVault Pro and MSP.")
    for (const label of ["Company name", "Primary color", "Accent color", "Prepared by", "Classification", "Footer text"]) expect(field(container, label).disabled).toBe(true)
    expect(button(container, "Upload logo").disabled).toBe(true)
    expect(button(container, "Save branding").disabled).toBe(true)
    expect(button(container, "Reset to TenuVault design").disabled).toBe(true)
    expect(container.querySelector("figure")?.textContent).toContain("Branded reports carry no TenuVault branding.")
  })

  it("keeps branding saved under an earlier plan inactive on Community and lets it be removed", async () => {
    pdfBranding.clear.mockResolvedValue({ branding: null, available: false })
    const container = await render("community", { branding: SAVED, available: false })
    expect(container.textContent).toContain("Saved branding for Fabrikam Security Services is kept but not applied until a tenant is on Pro or MSP.")
    await click(button(container, "Reset to TenuVault design"))
    expect(pdfBranding.clear).toHaveBeenCalledOnce()
    expect(field(container, "Company name").value).toBe("")
  })

  it("loads, previews and saves branding on Pro", async () => {
    pdfBranding.set.mockImplementation(async (branding) => ({ branding, available: true }))
    const container = await render("pro", { branding: SAVED, available: true })
    expect(container.textContent).not.toContain("Upgrade on the License page")
    expect(field(container, "Company name").value).toBe("Fabrikam Security Services")
    expect(field(container, "Primary color").value).toBe("#0B3D5C")
    expect(container.querySelector<HTMLImageElement>('img[alt="Current logo"]')?.src).toBe(PNG)
    const band = container.querySelector<HTMLDivElement>("figure div div")!
    expect(band.style.background).toBe("rgb(11, 61, 92)")
    type(field(container, "Company name"), "Contoso Advisory")
    type(field(container, "Footer text"), "Contoso | Review")
    expect(container.querySelector("figure")?.textContent).toContain("Contoso | Review")
    await click(button(container, "Remove logo"))
    await click(button(container, "Save branding"))
    expect(pdfBranding.set).toHaveBeenCalledWith({ companyName: "Contoso Advisory", colors: { primary: "#0B3D5C", accent: "#2BB3A3" }, preparedBy: "Avery", footerText: "Contoso | Review" })
  })

  it("checks colors and the company name before saving and opens the plan dialog on a plan refusal", async () => {
    const container = await render("msp", { branding: null, available: true })
    expect(field(container, "Primary color").value).toBe("#161514")
    expect(button(container, "Save branding").disabled).toBe(true)
    type(field(container, "Company name"), "Fabrikam")
    type(field(container, "Accent color"), "coral")
    expect(container.textContent).toContain("Enter a color as #RRGGBB.")
    await click(button(container, "Save branding"))
    expect(pdfBranding.set).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Enter both colors as #RRGGBB.")
    type(field(container, "Accent color"), "#7C3AED")
    pdfBranding.set.mockRejectedValue(new FeatureApiError("Full white-label PDF reports with your logo and colors: included in TenuVault Pro and MSP. Upgrade on the License page.", 402, "pdfBranding"))
    await click(button(container, "Save branding"))
    expect(planDialogError()).toMatchObject({ upgrade: "pdfBranding" })
    pdfBranding.set.mockRejectedValue(new Error("The logo can be at most 1 MB."))
    await click(button(container, "Save branding"))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The logo can be at most 1 MB.")
  })

  it("reads only PNG or JPEG logos of at most 1 MB", async () => {
    await expect(readLogo(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }))).rejects.toThrow("Choose a PNG or JPEG image.")
    await expect(readLogo(new File([new Uint8Array(1024 * 1024 + 1)], "logo.png", { type: "image/png" }))).rejects.toThrow("at most 1 MB")
    await expect(readLogo(new File([Buffer.from(PNG.split(",")[1]!, "base64")], "logo.png", { type: "image/png" }))).resolves.toBe(PNG)
    const container = await render("pro", { branding: null, available: true })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "logo.gif", { type: "image/gif" })] })
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })) })
    await flush()
    expect(container.textContent).toContain("Choose a PNG or JPEG image.")
    Object.defineProperty(input, "files", { configurable: true, value: [new File([Buffer.from(PNG.split(",")[1]!, "base64")], "logo.png", { type: "image/png" })] })
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })) })
    await waitFor(() => container.querySelector<HTMLImageElement>('img[alt="Current logo"]')?.src === PNG
      && container.querySelector<HTMLImageElement>('img[alt="Logo"]')?.src === PNG)
    expect(container.querySelector<HTMLImageElement>('img[alt="Current logo"]')?.src).toBe(PNG)
    expect(container.querySelector<HTMLImageElement>('img[alt="Logo"]')?.src).toBe(PNG)
  })
})
