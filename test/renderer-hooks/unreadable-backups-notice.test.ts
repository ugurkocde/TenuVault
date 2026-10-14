import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupSettings } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const backups = vi.hoisted(() => ({ settings: vi.fn(), chooseFolder: vi.fn(), importRecoveryKey: vi.fn(), inventoryProblem: vi.fn() }))

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { backups, app: { openExternal: async () => undefined } } }))
vi.mock("../../src/renderer/lib/license", () => ({ useTenantPlan: () => "msp" }))

import { StorageChooser } from "../../src/renderer/components/StorageChooser"
import { announceBackupSettings, localTenantIds, useLocalInventoryProblems, type LocalInventoryProblems } from "../../src/renderer/lib/local-inventory"

const TENANT = "11111111-1111-1111-1111-111111111111"
const OTHER = "22222222-2222-2222-2222-222222222222"
const PROBLEM = "Backup inventory is incomplete: 2 encrypted file(s) could not be read. Import the correct recovery keys or recover damaged files before continuing."
const affected: BackupSettings = { localFolder: "/old", keyFingerprint: "AAAA", recoveryExported: false, hasLocalBackups: true }
const readable = (folder = "/new"): BackupSettings => ({ ...affected, localFolder: folder, hasLocalBackups: false })

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve: async (value: T) => { await act(async () => resolve(value)); await flush() } }
}

function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return { container, root }
}

async function renderChooser() {
  const onChange = vi.fn()
  const { container } = mount(createElement(StorageChooser, { tenantId: TENANT.toUpperCase(), clientId: "client", onChange }))
  await flush()
  return { container, onChange, last: () => onChange.mock.calls.at(-1)?.[0] }
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`No button ${label}`)
  await act(async () => button.click())
  await flush()
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function importKey(container: HTMLElement, key: string) {
  await click(container, "Import recovery key")
  type(container.querySelector("textarea")!, key)
  await click(container, "Import")
}

describe("storage step with a folder this device cannot read", () => {
  it("warns about the tenant's folder but never holds back the local choice", async () => {
    backups.settings.mockResolvedValue(affected)
    const check = deferred<string | null>()
    backups.inventoryProblem.mockReturnValue(check.promise)
    const { container, onChange, last } = await renderChooser()
    expect(onChange).toHaveBeenCalled()
    expect(last()).toEqual({ kind: "local" })
    expect(backups.inventoryProblem).toHaveBeenCalledWith(TENANT)
    expect(container.textContent).toContain("Checking this tenant's backups in the folder")
    expect(container.textContent).not.toContain("backups this device cannot read")

    await check.resolve(PROBLEM)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).toContain("This folder has backups this device cannot read")
    expect(container.textContent).not.toContain("Checking this tenant's backups")
  })

  it("clears the warning once the check after Choose another folder is clean", async () => {
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockResolvedValueOnce(PROBLEM)
    const { container, last } = await renderChooser()
    expect(last()).toEqual({ kind: "local" })

    const recheck = deferred<string | null>()
    backups.inventoryProblem.mockReturnValueOnce(recheck.promise)
    backups.chooseFolder.mockResolvedValue(readable())
    await click(container, "Choose another folder")
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(2)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).toContain("Checking the backups in the folder")

    await recheck.resolve(null)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).not.toContain("backups this device cannot read")
    expect(container.textContent).toContain("/new")
  })

  it("stays quiet when the folder picker is cancelled, and explains a chosen folder that has a problem too", async () => {
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockResolvedValue(PROBLEM)
    // A cancelled picker returns a fresh read of the same folder.
    backups.chooseFolder.mockResolvedValueOnce({ ...affected })
    const { container, last } = await renderChooser()
    await click(container, "Choose another folder")
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(2)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).toContain("This folder has backups this device cannot read")
    expect(container.textContent).not.toContain("also has backups")
    expect(container.textContent).not.toContain("still cannot read")

    backups.chooseFolder.mockResolvedValueOnce({ ...affected, localFolder: "/other" })
    await click(container, "Choose another folder")
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(3)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).toContain("The folder you chose also has backups this device cannot read")
  })

  it("explains a recovery key that does not open the backups once the check after the import finishes", async () => {
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockResolvedValueOnce(PROBLEM)
    const { container, last } = await renderChooser()
    const recheck = deferred<string | null>()
    backups.inventoryProblem.mockReturnValueOnce(recheck.promise)
    backups.importRecoveryKey.mockResolvedValueOnce({ ...affected, keyFingerprint: "BBBB" })
    await importKey(container, "TVK2.wrong")
    expect(backups.importRecoveryKey).toHaveBeenCalledWith("TVK2.wrong")
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Checking the backups in the folder")
    expect(container.textContent).not.toContain("still cannot read")

    await recheck.resolve(PROBLEM)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).toContain("This device still cannot read some of these backups")
  })

  it.each([
    ["a new current key", "CCCC"],
    // A bundle whose first key is already this device's adds older keys and keeps the fingerprint.
    ["older keys only", "AAAA"],
  ])("releases the choice after a recovery key that opens the backups (%s)", async (_case, keyFingerprint) => {
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockResolvedValueOnce(PROBLEM).mockResolvedValueOnce(null)
    const { container, last } = await renderChooser()
    expect(last()).toEqual({ kind: "local" })
    backups.importRecoveryKey.mockResolvedValueOnce({ ...affected, keyFingerprint })
    await importKey(container, "TVK2.right")
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(2)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).not.toContain("backups this device cannot read")
  })

  it("does not hold back the choice when the check or the settings cannot be read", async () => {
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockRejectedValue(new Error("unavailable"))
    const failedCheck = await renderChooser()
    expect(failedCheck.last()).toEqual({ kind: "local" })
    expect(failedCheck.container.textContent).not.toContain("backups this device cannot read")

    backups.settings.mockRejectedValue(new Error("unavailable"))
    const failedSettings = await renderChooser()
    expect(failedSettings.last()).toEqual({ kind: "local" })
  })

  it("ignores another tenant's problem", async () => {
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockImplementation(async (tenantId: string) => (tenantId === OTHER ? PROBLEM : null))
    const { container, last } = await renderChooser()
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(1)
    expect(last()).toEqual({ kind: "local" })
    expect(container.textContent).not.toContain("backups this device cannot read")
  })
})

describe("useLocalInventoryProblems", () => {
  function renderHook(settings: BackupSettings | null, tenantIds: string[]) {
    const seen: LocalInventoryProblems[] = []
    const Probe = (props: { settings: BackupSettings | null; tenantIds: string[] }) => {
      seen.push(useLocalInventoryProblems(props.settings, props.tenantIds))
      return null
    }
    const { root } = mount(createElement(Probe, { settings, tenantIds }))
    return {
      latest: () => seen.at(-1)!,
      rerender: (next: BackupSettings | null, ids = tenantIds) => act(() => root.render(createElement(Probe, { settings: next, tenantIds: ids }))),
    }
  }

  it("checks only the tenants connected on this device that keep backups in the local folder", async () => {
    const ids = localTenantIds([
      { resources: { storageAccountName: `tvlocal-${TENANT}` } },
      { resources: { storageAccountName: "contosobackups" } },
      {},
      { resources: { storageAccountName: `tvlocal-${OTHER}` } },
    ] as Parameters<typeof localTenantIds>[0])
    expect(ids).toEqual([TENANT, OTHER])
    backups.inventoryProblem.mockImplementation(async (tenantId: string) => (tenantId === OTHER ? PROBLEM : null))
    const hook = renderHook(affected, ids)
    expect(hook.latest().checking).toBe(true)
    await flush()
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(2)
    expect(hook.latest()).toEqual({ affected: [OTHER], checking: false })
  })

  it("checks again when the tenants change, and not for the same settings", async () => {
    backups.inventoryProblem.mockResolvedValue(null)
    const hook = renderHook(affected, [TENANT])
    await flush()
    hook.rerender(affected, [TENANT.toUpperCase()])
    await flush()
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(1)
    backups.inventoryProblem.mockResolvedValue(PROBLEM)
    hook.rerender(affected, [TENANT, OTHER])
    await flush()
    expect(backups.inventoryProblem).toHaveBeenCalledTimes(3)
    expect(hook.latest()).toEqual({ affected: [TENANT, OTHER], checking: false })
    hook.rerender(affected, [OTHER])
    await flush()
    expect(hook.latest()).toEqual({ affected: [OTHER], checking: false })
  })

  it("does not check without settings or tenants", async () => {
    const hook = renderHook(null, [TENANT])
    await flush()
    hook.rerender(affected, [])
    await flush()
    expect(backups.inventoryProblem).not.toHaveBeenCalled()
    expect(hook.latest()).toEqual({ affected: [], checking: false })
  })

  it("ignores the answer for a folder that is no longer current", async () => {
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    backups.inventoryProblem.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const hook = renderHook(affected, [TENANT])
    hook.rerender(readable())
    await second.resolve(null)
    await first.resolve(PROBLEM)
    expect(hook.latest()).toEqual({ affected: [], checking: false })
  })

  it("refreshes another open view after a fix, as the Settings card after the Change storage dialog", async () => {
    let folder = "/old"
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockImplementation(async () => (folder === "/old" ? PROBLEM : null))
    backups.chooseFolder.mockImplementation(async () => { folder = "/new"; return readable() })
    const dialog = await renderChooser()
    const card = await renderChooser()
    expect(card.container.textContent).toContain("cannot read")
    await click(dialog.container, "Choose another folder")
    await flush()
    expect(card.container.textContent).not.toContain("cannot read")
    expect(card.container.textContent).toContain("/new")
    expect(card.last()).toEqual({ kind: "local" })
  })

  it("stops showing the check when it does not answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      backups.settings.mockResolvedValue(affected)
      backups.inventoryProblem.mockReturnValue(new Promise(() => {}))
      const onChange = vi.fn()
      const { container } = mount(createElement(StorageChooser, { tenantId: TENANT, clientId: "client", onChange }))
      await act(async () => { await Promise.resolve() })
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ kind: "local" })
      expect(container.textContent).toContain("Checking this tenant's backups")
      await act(async () => { vi.advanceTimersByTime(15_000) })
      await act(async () => { await Promise.resolve() })
      expect(container.textContent).not.toContain("Checking this tenant's backups")
      expect(container.textContent).not.toContain("cannot read")
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a newer folder from another view when the first settings read finishes later", async () => {
    const read = deferred<BackupSettings>()
    backups.settings.mockReturnValue(read.promise)
    backups.inventoryProblem.mockResolvedValue(null)
    const { container } = await renderChooser()
    await act(async () => announceBackupSettings(readable("/new")))
    await flush()
    await read.resolve(affected)
    expect(container.textContent).toContain("/new")
    expect(container.textContent).not.toContain("/old")
  })

  it("runs one folder change at a time, so a slower answer cannot replace a newer folder", async () => {
    backups.settings.mockResolvedValue(affected)
    backups.inventoryProblem.mockResolvedValue(PROBLEM)
    const picked = deferred<BackupSettings>()
    backups.chooseFolder.mockReturnValueOnce(picked.promise)
    const { container } = await renderChooser()
    const choose = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Choose another folder")!
    await act(async () => choose().click())
    expect(choose().disabled).toBe(true)
    await act(async () => choose().click())
    expect(backups.chooseFolder).toHaveBeenCalledTimes(1)
    backups.inventoryProblem.mockResolvedValue(null)
    await picked.resolve(readable("/b"))
    expect(container.textContent).toContain("/b")
  })
})

