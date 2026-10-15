import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BackupSettings } from "../../src/shared/ipc"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const backups = vi.hoisted(() => ({
  settings: vi.fn(),
  inventoryProblem: vi.fn(),
  verifyAzureStorage: vi.fn(),
  exportRecoveryKey: vi.fn(),
}))
const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }))

vi.mock("../../src/renderer/lib/bridge", () => ({ bridge: { backups, app: { openExternal: async () => undefined } } }))
vi.mock("../../src/renderer/lib/license", () => ({ useTenantPlan: () => "pro" }))

import { StorageChooser } from "../../src/renderer/components/StorageChooser"
import { announceBackupSettings, useBackupSettings } from "../../src/renderer/lib/local-inventory"

const TENANT = "11111111-1111-1111-1111-111111111111"
const ACCOUNT = { name: "tvbkpabc123", subscriptionId: "sub-1", resourceGroup: "rg-tenuvault-backups", location: "westeurope" }
const unsaved: BackupSettings = { localFolder: "/backups", keyFingerprint: "AAAA", recoveryExported: false, hasLocalBackups: false }
const saved: BackupSettings = { ...unsaved, recoveryExported: true }

const roots: Root[] = []
const containers: HTMLDivElement[] = []
const fetchMock = vi.fn()

function accountResponse(accounts: unknown[]) {
  return { ok: true, json: async () => ({ storageAccounts: accounts }) }
}

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

async function renderChooser() {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard })
  vi.stubGlobal("fetch", fetchMock)
  const onChange = vi.fn()
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(StorageChooser, { tenantId: TENANT, clientId: "client", onChange })))
  await flush()
  const unmount = () => {
    const index = roots.indexOf(root)
    if (index >= 0) roots.splice(index, 1)
    act(() => root.unmount())
  }
  return { container, onChange, unmount, last: () => onChange.mock.calls.at(-1)?.[0] }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))
  if (!button) throw new Error(`No button containing ${text}`)
  return button as HTMLButtonElement
}

async function clickText(container: HTMLElement, text: string) {
  const button = buttonByText(container, text)
  await act(async () => button.click())
  await flush()
}

async function chooseAzure(container: HTMLElement) {
  await clickText(container, "Your Azure storage account, encrypted")
}

async function selectAccount(container: HTMLElement, name: string) {
  const select = container.querySelector("select")!
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(select, name)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await flush()
}

describe("storage chooser Azure path", () => {
  it("holds back the Azure choice until the recovery key is saved in the step", async () => {
    backups.settings.mockResolvedValueOnce(unsaved)
    backups.settings.mockResolvedValue(saved)
    backups.inventoryProblem.mockResolvedValue(null)
    backups.verifyAzureStorage.mockResolvedValue(undefined)
    backups.exportRecoveryKey.mockResolvedValue({ saved: true, path: "/tmp/key.txt" })
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const { container, last } = await renderChooser()
    await chooseAzure(container)
    expect(container.textContent).toContain("Save your recovery key before you continue")

    await selectAccount(container, ACCOUNT.name)
    await clickText(container, "Check access")
    expect(container.textContent).toContain("Access confirmed")
    expect(last()).toBeNull()

    await clickText(container, "Save recovery key")
    expect(backups.exportRecoveryKey).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain("Save your recovery key before you continue")
    expect(last()).toEqual({
      kind: "azure",
      storageAccountName: ACCOUNT.name,
      subscriptionId: ACCOUNT.subscriptionId,
      resourceGroupName: ACCOUNT.resourceGroup,
      location: ACCOUNT.location,
    })
  })

  it("offers the setup script when no account is visible and refresh finds a new one", async () => {
    backups.settings.mockResolvedValue(saved)
    backups.inventoryProblem.mockResolvedValue(null)
    fetchMock.mockResolvedValueOnce(accountResponse([]))

    const { container } = await renderChooser()
    await chooseAzure(container)
    expect(container.textContent).toContain("No storage account yet?")

    clipboard.writeText.mockResolvedValue(undefined)
    await clickText(container, "Copy setup instructions for your Azure administrator")
    expect(clipboard.writeText).toHaveBeenCalledOnce()
    expect(String(clipboard.writeText.mock.calls[0]?.[0])).toContain("https://docs.tenuvault.com/getting-started/create-storage-account/")
    expect(String(clipboard.writeText.mock.calls[0]?.[0])).toContain("New-TenuVaultStorage")
    expect(container.textContent).toContain("Copied")

    fetchMock.mockResolvedValueOnce(accountResponse([ACCOUNT]))
    await clickText(container, "Refresh")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.querySelector("select")).not.toBeNull()
    expect(container.textContent).toContain(ACCOUNT.name)
  })

  it("retries the account list from the error state", async () => {
    backups.settings.mockResolvedValue(saved)
    backups.inventoryProblem.mockResolvedValue(null)
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "list failed" }) })

    const { container } = await renderChooser()
    await chooseAzure(container)
    expect(container.textContent).toContain("list failed")

    fetchMock.mockResolvedValueOnce(accountResponse([ACCOUNT]))
    await clickText(container, "Refresh")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain(ACCOUNT.name)
    expect(container.textContent).not.toContain("list failed")
  })

  it("never transfers a finished access check to a different account", async () => {
    const other = { ...ACCOUNT, name: "tvbkpother1" }
    backups.settings.mockResolvedValue(saved)
    backups.inventoryProblem.mockResolvedValue(null)
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT, other]))
    let resolveVerify!: () => void
    backups.verifyAzureStorage.mockReturnValue(new Promise<void>((resolve) => { resolveVerify = resolve }))

    const { container, last } = await renderChooser()
    await chooseAzure(container)
    await selectAccount(container, ACCOUNT.name)
    await clickText(container, "Check access")
    await selectAccount(container, other.name)
    await act(async () => resolveVerify())
    await flush()

    expect(container.textContent).not.toContain("Access confirmed")
    expect(last()).toBeNull()

    await selectAccount(container, ACCOUNT.name)
    expect(container.textContent).toContain("Access confirmed")
    expect(last()).toMatchObject({ kind: "azure", storageAccountName: ACCOUNT.name })
  })

  it("retries the recovery key check after the settings read fails", async () => {
    backups.settings.mockRejectedValueOnce(new Error("settings unavailable"))
    backups.settings.mockResolvedValue(saved)
    backups.inventoryProblem.mockResolvedValue(null)
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const { container } = await renderChooser()
    await chooseAzure(container)
    expect(container.textContent).toContain("Could not check whether your recovery key is saved")

    await clickText(container, "Try again")
    expect(container.textContent).not.toContain("Could not check whether your recovery key is saved")
    expect(container.textContent).toContain(ACCOUNT.name)
  })

  it("discards a settings read that finishes after the chooser closed", async () => {
    const savedKeyA: BackupSettings = { ...unsaved, keyFingerprint: "AAAA", recoveryExported: true }
    const unsavedKeyB: BackupSettings = { ...unsaved, keyFingerprint: "BBBB", recoveryExported: false }
    let resolveStaleRead!: (value: BackupSettings) => void
    const staleRead = new Promise<BackupSettings>((resolve) => { resolveStaleRead = resolve })
    backups.settings
      .mockResolvedValueOnce({ ...unsaved, keyFingerprint: "AAAA" })
      .mockReturnValueOnce(staleRead)
      .mockResolvedValue(unsavedKeyB)
    backups.inventoryProblem.mockResolvedValue(null)
    backups.verifyAzureStorage.mockResolvedValue(undefined)
    backups.exportRecoveryKey.mockResolvedValue({ saved: true, path: "/tmp/key.txt" })
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const first = await renderChooser()
    await chooseAzure(first.container)
    await clickText(first.container, "Save recovery key")
    first.unmount()

    const second = await renderChooser()
    await chooseAzure(second.container)
    await selectAccount(second.container, ACCOUNT.name)
    await clickText(second.container, "Check access")
    expect(second.container.textContent).toContain("Save your recovery key before you continue")
    expect(second.last()).toBeNull()

    await act(async () => resolveStaleRead(savedKeyA))
    await flush()
    expect(second.container.textContent).toContain("Save your recovery key before you continue")
    expect(second.last()).toBeNull()
  })

  it("discards a settings read superseded by an announcement in the same batch", async () => {
    const savedKeyA: BackupSettings = { ...unsaved, keyFingerprint: "AAAA", recoveryExported: true }
    const unsavedKeyB: BackupSettings = { ...unsaved, keyFingerprint: "BBBB", recoveryExported: false }
    let resolveStaleRead!: (value: BackupSettings) => void
    const staleRead = new Promise<BackupSettings>((resolve) => { resolveStaleRead = resolve })
    backups.settings
      .mockResolvedValueOnce({ ...unsaved, keyFingerprint: "AAAA" })
      .mockReturnValueOnce(staleRead)
    backups.inventoryProblem.mockResolvedValue(null)
    backups.verifyAzureStorage.mockResolvedValue(undefined)
    backups.exportRecoveryKey.mockResolvedValue({ saved: true, path: "/tmp/key.txt" })
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const { container, last } = await renderChooser()
    await chooseAzure(container)
    await clickText(container, "Save recovery key")

    await act(async () => {
      announceBackupSettings(unsavedKeyB)
      resolveStaleRead(savedKeyA)
    })
    await flush()
    expect(container.textContent).toContain("Save your recovery key before you continue")

    await selectAccount(container, ACCOUNT.name)
    await clickText(container, "Check access")
    expect(last()).toBeNull()
  })

  it("keeps a successful key save when another view hydrates its settings meanwhile", async () => {
    let resolveSavedRead!: (value: BackupSettings) => void
    const savedRead = new Promise<BackupSettings>((resolve) => { resolveSavedRead = resolve })
    backups.settings
      .mockResolvedValueOnce(unsaved)
      .mockReturnValueOnce(savedRead)
      .mockResolvedValue(unsaved)
    backups.inventoryProblem.mockResolvedValue(null)
    backups.verifyAzureStorage.mockResolvedValue(undefined)
    backups.exportRecoveryKey.mockResolvedValue({ saved: true, path: "/tmp/key.txt" })
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const { container, last } = await renderChooser()
    await chooseAzure(container)
    await selectAccount(container, ACCOUNT.name)
    await clickText(container, "Check access")
    await clickText(container, "Save recovery key")

    const probeContainer = document.createElement("div")
    document.body.appendChild(probeContainer)
    containers.push(probeContainer)
    const probeRoot = createRoot(probeContainer)
    roots.push(probeRoot)
    const Probe = () => {
      useBackupSettings()
      return createElement("div", null, "probe")
    }
    act(() => probeRoot.render(createElement(Probe)))
    await flush()

    await act(async () => resolveSavedRead(saved))
    await flush()
    expect(container.textContent).not.toContain("Save your recovery key before you continue")
    expect(last()).toMatchObject({ kind: "azure", storageAccountName: ACCOUNT.name })
  })
})
