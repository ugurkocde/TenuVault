import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupSettings } from "../../src/shared/ipc"
import type { DamageKind, DamagedFileKinds } from "../../src/shared/damaged-files"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const backups = vi.hoisted(() => ({ importRecoveryKey: vi.fn(), openFolder: vi.fn(), chooseFolder: vi.fn() }))
vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { backups } }))

import { DamagedBackupFilesNotice } from "../../src/renderer/components/DamagedBackupFilesNotice"
import { LegacySealedBackupsNotice } from "../../src/renderer/components/LegacySealedBackupsNotice"
import { UnreadableBackupsNotice } from "../../src/renderer/components/UnreadableBackupsNotice"

const TENANT = "11111111-1111-1111-1111-111111111111"
const CARD = "space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
const settings: BackupSettings = { localFolder: "/backups", keyFingerprint: "BBBB", recoveryExported: true, hasLocalBackups: true }
const roots: Root[] = []
const containers: HTMLDivElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  for (const container of containers.splice(0)) container.remove()
  vi.resetAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const hex = (index: number) => `${index.toString(16).padStart(40, "0")}.tvb`

/** Kinds with the given counts, naming up to ten files in all. */
function kinds(counts: Partial<Record<DamageKind, number>>, codes: string[] = []): DamagedFileKinds {
  const result: DamagedFileKinds = { counts: { key: 0, os: 0, duplicate: 0, damaged: 0, ...counts }, codes, names: { key: [], os: [], duplicate: [], damaged: [] } }
  let next = 0
  for (const kind of ["key", "os", "duplicate", "damaged"] as const) {
    for (let index = 0; index < result.counts[kind] && next < 10; index++) result.names[kind].push(hex(next++))
  }
  return result
}

interface Props { count: number; kinds: DamagedFileKinds | null; names?: string[]; unavailable?: number; onImported?: () => Promise<void> }

function render(props: Props) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  const onImported = props.onImported ?? vi.fn(async () => undefined)
  const draw = (next: Props) => act(() => root.render(createElement(DamagedBackupFilesNotice, { names: [], unavailable: 0, tenantId: TENANT, ...next, onImported })))
  draw(props)
  return { container, draw, onImported }
}

const labels = (container: HTMLElement) => [...container.querySelectorAll("button")].map((button) => button.textContent?.trim())

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`No button ${label}`)
  await act(async () => button.click())
  await flush()
}

async function importKey(container: HTMLElement) {
  await click(container, "Import recovery key")
  const textarea = container.querySelector("textarea")!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    setter.call(textarea, "TVK2.example")
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await click(container, "Import")
}

describe("damaged backup files notice", () => {
  it("shows nothing when every file can be read", () => {
    expect(render({ count: 0, kinds: null }).container.textContent).toBe("")
  })

  it("is a status card with a title and no file names until they are shown", () => {
    const { container } = render({ count: 129, kinds: kinds({ key: 129 }) })
    const card = container.querySelector("[role=status]")!
    expect(card.className).toBe(`${CARD} mb-4`)
    expect(container.querySelector("[role=alert]")).toBeNull()
    expect(card.querySelector("p.font-medium")?.textContent).toBe("Some backups may be missing from this list")
    expect(container.textContent).not.toMatch(/[0-9a-f]{40}\.tvb/)
    expect(container.textContent).not.toContain("These are the encrypted names on disk")
  })

  it.each([
    ["key", { key: 129 }, [], "TenuVault cannot read 129 files in this tenant's backup folder. Most often they were made with a different recovery key, for example by another device or an earlier installation. They can also be damaged."],
    ["key", { key: 1 }, [], "TenuVault cannot read 1 file in this tenant's backup folder. Most often it was made with a different recovery key, for example by another device or an earlier installation. It can also be damaged."],
    ["os", { os: 9 }, ["EACCES", "EPERM"], "TenuVault cannot open 9 files in this tenant's backup folder (EACCES, EPERM). Check the folder's permissions, and that a sync app has downloaded the files, then select Refresh."],
    ["os", { os: 1 }, ["EACCES"], "TenuVault cannot open 1 file in this tenant's backup folder (EACCES). Check the folder's permissions, and that a sync app has downloaded the files, then select Refresh."],
    ["duplicate", { duplicate: 4 }, [], "4 files in this tenant's backup folder hold the same backup item twice, for example after a backup folder was copied in by hand. Keep one copy of each, then select Refresh."],
    ["duplicate", { duplicate: 1 }, [], "1 file in this tenant's backup folder holds a backup item that another file also holds, for example after a backup folder was copied in by hand. Keep one copy of each, then select Refresh."],
    ["damaged", { damaged: 3 }, [], "TenuVault cannot read 3 files in this tenant's backup folder. They are damaged or incomplete. Restore them from a copy, then select Refresh."],
    ["damaged", { damaged: 1 }, [], "TenuVault cannot read 1 file in this tenant's backup folder. It is damaged or incomplete. Restore it from a copy, then select Refresh."],
    ["mixed with key", { key: 120, os: 9 }, ["EACCES"], "TenuVault cannot read 129 files in this tenant's backup folder, for different reasons. Show file names lists them by reason. Some may have been made with a different recovery key, for example by another device or an earlier installation."],
    ["mixed without key", { os: 2, damaged: 3 }, ["EIO"], "TenuVault cannot read 5 files in this tenant's backup folder, for different reasons. Show file names lists them by reason."],
  ] as const)("words the body for %s files", (_kind, counts, codes, body) => {
    const count = Object.values(counts).reduce((sum: number, value) => sum + (value ?? 0), 0)
    const { container } = render({ count, kinds: kinds(counts, [...codes]) })
    const paragraphs = [...container.querySelectorAll("[role=status] > div > div > p")].map((p) => p.textContent)
    expect(paragraphs).toEqual([body, "Your other backups work and new backups are still saved. Until this is fixed, older backups are not deleted."])
    expect(labels(container).includes("Import recovery key")).toBe(("key" in counts ? counts.key : 0) > 0)
    expect(labels(container)).toContain("Open backup folder")
    expect(labels(container)).toContain(`Show file names (${count})`)
    expect(labels(container)).not.toContain("Choose another folder")
  })

  it("says how many backups in the list are marked Unavailable, only when there are some", () => {
    const { container, draw } = render({ count: 2, kinds: kinds({ damaged: 2 }), unavailable: 1 })
    expect(container.textContent).toContain("1 backup in this list is marked Unavailable. Your other backups work")
    draw({ count: 2, kinds: kinds({ damaged: 2 }), unavailable: 3 })
    expect(container.textContent).toContain("3 backups in this list are marked Unavailable. Your other backups work")
    draw({ count: 2, kinds: kinds({ damaged: 2 }), unavailable: 0 })
    expect(container.textContent).not.toContain("marked Unavailable")
  })

  it("treats a list without kinds as damaged files", () => {
    const { container } = render({ count: 2, kinds: null, names: [hex(1), hex(2)] })
    expect(container.textContent).toContain("They are damaged or incomplete.")
    expect(labels(container)).not.toContain("Import recovery key")
  })

  it("shows the file names behind a disclosure that is a button with aria-expanded and aria-controls", async () => {
    const { container } = render({ count: 129, kinds: kinds({ key: 129 }) })
    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Show file names"))!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeNull()
    expect(toggle.className).toContain("focus-visible:ring-[3px]")
    await act(async () => toggle.click())
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.textContent?.trim()).toBe("Hide file names")
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain("These are the encrypted names on disk, so you can find the files. They do not match backup or policy names.")
    const list = panel.querySelector(".max-h-40.overflow-auto")!
    expect([...list.querySelectorAll("li")].map((item) => item.textContent)).toEqual(Array.from({ length: 10 }, (_, index) => hex(index)))
    expect(list.querySelector("ul")!.className).toContain("font-mono text-xs break-all")
    expect(list.textContent).toContain("and 119 more")
    expect(panel.lastElementChild?.textContent).toBe("If you have no copy and no recovery key, you can remove these files from the folder yourself. TenuVault never removes them for you.")
    await act(async () => toggle.click())
    expect(panel.isConnected).toBe(false)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })

  it("lists mixed files by reason, each with its count", async () => {
    const { container } = render({ count: 129, kinds: kinds({ key: 120, os: 9 }, ["EACCES"]) })
    await click(container, "Show file names (129)")
    const groups = [...container.querySelectorAll(".max-h-40 > div")].map((group) => group.querySelector("p")?.textContent)
    expect(groups).toEqual(["120 made with another key or damaged", "9 could not be opened (EACCES)"])
    expect(container.textContent).toContain("and 110 more")
  })

  it("opens the tenant's backup folder and says so when that fails", async () => {
    backups.openFolder.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("The folder could not be opened."))
    const { container } = render({ count: 2, kinds: kinds({ damaged: 2 }) })
    await click(container, "Open backup folder")
    expect(backups.openFolder).toHaveBeenCalledWith(TENANT)
    expect(container.textContent).not.toContain("could not be opened")
    await click(container, "Open backup folder")
    expect(container.querySelector("p.text-red-700")?.textContent).toBe("The folder could not be opened.")
  })

  it("lists the backups again after an import and says how many files still cannot be read", async () => {
    backups.importRecoveryKey.mockResolvedValue(settings)
    let draw!: (props: Props) => void
    const announced = vi.fn()
    window.addEventListener("tenuvault:backup-settings", announced)
    let finish!: () => void
    const onImported = vi.fn(() => new Promise<void>((resolve) => { finish = () => { draw({ count: 5, kinds: kinds({ key: 5 }) }); resolve() } }))
    const rendered = render({ count: 129, kinds: kinds({ key: 129 }), onImported })
    draw = (props) => rendered.draw({ ...props, onImported })
    await importKey(rendered.container)
    expect(backups.importRecoveryKey).toHaveBeenCalledWith("TVK2.example")
    expect(onImported).toHaveBeenCalledOnce()
    expect(announced).toHaveBeenCalledOnce()
    expect(rendered.container.textContent).toContain("Checking the backups again...")
    expect(labels(rendered.container).find((label) => label === "Import recovery key")).toBeDefined()
    expect([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Import recovery key")!.disabled).toBe(true)
    await act(async () => finish())
    await flush()
    expect(rendered.container.textContent).not.toContain("Checking the backups again...")
    expect(rendered.container.textContent).toContain("This device still cannot read 5 of these files. They need a different recovery key, or a copy from before they were damaged.")
    window.removeEventListener("tenuvault:backup-settings", announced)
  })

  it("words the still-unreadable line for one file", async () => {
    backups.importRecoveryKey.mockResolvedValue(settings)
    const { container } = render({ count: 1, kinds: kinds({ key: 1 }) })
    await importKey(container)
    expect(container.textContent).toContain("This device still cannot read this file. It needs a different recovery key, or a copy from before it was damaged.")
  })

  it("goes away once the list after an import has no damaged files", async () => {
    backups.importRecoveryKey.mockResolvedValue(settings)
    let draw!: (props: Props) => void
    const onImported = vi.fn(async () => { draw({ count: 0, kinds: null }) })
    const rendered = render({ count: 3, kinds: kinds({ key: 3 }), onImported })
    draw = (props) => rendered.draw({ ...props, onImported })
    await importKey(rendered.container)
    expect(rendered.container.textContent).toBe("")
    draw({ count: 1, kinds: kinds({ key: 1 }) })
    expect(rendered.container.textContent).not.toContain("still cannot read")
  })

  it("shows an import error inline", async () => {
    backups.importRecoveryKey.mockRejectedValue(new Error("That is not a recovery key."))
    const { container, onImported } = render({ count: 2, kinds: kinds({ key: 2 }) })
    await importKey(container)
    expect(onImported).not.toHaveBeenCalled()
    expect(container.querySelector("p.text-red-700")?.textContent).toBe("That is not a recovery key.")
  })
})

describe("backup notices on the shared card", () => {
  function mount(element: ReturnType<typeof createElement>) {
    const container = document.createElement("div")
    document.body.appendChild(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => root.render(element))
    return container
  }

  it("keeps the legacy sealed notice's role, classes, wording and action", () => {
    const container = mount(createElement(LegacySealedBackupsNotice, { count: 2, onImported: async () => undefined }))
    const card = container.querySelector("[role=status]")!
    expect(card.className).toBe(`${CARD} mb-4`)
    expect(card.querySelector("p.font-medium")?.textContent).toBe("2 older Azure backups need a recovery key")
    expect(card.querySelector(".mt-1 > p")?.textContent).toContain("These backups were encrypted by an earlier TenuVault version")
    const button = card.querySelector("button")!
    expect(button.textContent?.trim()).toBe("Import recovery key")
    expect(button.className).toContain("bg-white")
  })

  it("keeps the unreadable folder notice an alert with both actions", () => {
    const container = mount(createElement(UnreadableBackupsNotice, { settings, affected: true, checking: false, onChange: () => undefined }))
    const card = container.querySelector("[role=alert]")!
    expect(card.className).toBe(CARD)
    expect(container.querySelector("[role=status]")).toBeNull()
    expect(card.querySelector("p.font-medium")?.textContent).toBe("This folder has backups this device cannot read")
    expect(card.querySelector(".mt-1 > p")?.textContent).toContain("were made with a different recovery key")
    expect(card.querySelector(".mt-1 .font-mono")?.textContent).toBe("/backups")
    expect([...card.querySelectorAll(".flex.flex-wrap.gap-2 > button")].map((button) => button.textContent?.trim())).toEqual(["Import recovery key", "Choose another folder"])
  })
})
