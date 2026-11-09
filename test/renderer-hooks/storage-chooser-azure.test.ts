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

import { azureStorageBlocker, StorageChooser, type StorageChooserDraft } from "../../src/renderer/components/StorageChooser"

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

async function renderChooser(initialDraft?: StorageChooserDraft) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard })
  vi.stubGlobal("fetch", fetchMock)
  const onChange = vi.fn()
  const onDraftChange = vi.fn()
  const container = document.createElement("div")
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(createElement(StorageChooser, { tenantId: TENANT, clientId: "client", onChange, onDraftChange, initialDraft })))
  await flush()
  const unmount = () => {
    const index = roots.indexOf(root)
    if (index >= 0) roots.splice(index, 1)
    act(() => root.unmount())
  }
  return { container, onChange, onDraftChange, unmount, last: () => onChange.mock.calls.at(-1)?.[0], lastDraft: () => onDraftChange.mock.calls.at(-1)?.[0] as StorageChooserDraft }
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
  await clickText(container, "Your Azure storage account")
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
  it("completes the Azure choice once access is confirmed, without a recovery key", async () => {
    backups.settings.mockResolvedValue(unsaved)
    backups.inventoryProblem.mockResolvedValue(null)
    backups.verifyAzureStorage.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const { container, last } = await renderChooser()
    await chooseAzure(container)
    expect(container.textContent).not.toContain("recovery key")
    expect(container.textContent).toContain("Azure encrypts the data at rest")
    expect(container.textContent).toContain("every admin with access to the account sees the same backups")

    await selectAccount(container, ACCOUNT.name)
    expect(last()).toBeNull()
    await clickText(container, "Check access")
    expect(container.textContent).toContain("Access confirmed")
    expect(backups.exportRecoveryKey).not.toHaveBeenCalled()
    expect(last()).toEqual({
      kind: "azure",
      storageAccountName: ACCOUNT.name,
      subscriptionId: ACCOUNT.subscriptionId,
      resourceGroupName: ACCOUNT.resourceGroup,
      location: ACCOUNT.location,
    })
  })

  it("does not depend on the backup settings read for the Azure choice", async () => {
    backups.settings.mockRejectedValue(new Error("settings unavailable"))
    backups.inventoryProblem.mockResolvedValue(null)
    backups.verifyAzureStorage.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const { container, last } = await renderChooser()
    await chooseAzure(container)
    await selectAccount(container, ACCOUNT.name)
    await clickText(container, "Check access")
    expect(last()).toMatchObject({ kind: "azure", storageAccountName: ACCOUNT.name })
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

  it("restores a verified Azure draft after a remount without checking access again", async () => {
    backups.settings.mockResolvedValue(saved)
    backups.inventoryProblem.mockResolvedValue(null)
    backups.verifyAzureStorage.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const first = await renderChooser()
    await chooseAzure(first.container)
    await selectAccount(first.container, ACCOUNT.name)
    await clickText(first.container, "Check access")
    expect(first.last()).toEqual(expect.objectContaining({ kind: "azure", storageAccountName: ACCOUNT.name }))
    const draft = first.lastDraft()
    expect(draft).toEqual({ kind: "azure", selectedAccount: ACCOUNT.name, verifiedAccount: ACCOUNT.name })
    first.unmount()

    const second = await renderChooser(draft)
    expect(second.container.textContent).toContain("Access confirmed")
    await flush()
    expect(second.last()).toEqual({
      kind: "azure",
      storageAccountName: ACCOUNT.name,
      subscriptionId: ACCOUNT.subscriptionId,
      resourceGroupName: ACCOUNT.resourceGroup,
      location: ACCOUNT.location,
    })
    expect(backups.verifyAzureStorage).toHaveBeenCalledOnce()
  })

  it("restores an unverified Azure draft after a remount and still holds the choice back", async () => {
    backups.settings.mockResolvedValue(saved)
    backups.inventoryProblem.mockResolvedValue(null)
    fetchMock.mockResolvedValue(accountResponse([ACCOUNT]))

    const first = await renderChooser()
    await chooseAzure(first.container)
    await selectAccount(first.container, ACCOUNT.name)
    const draft = first.lastDraft()
    expect(draft).toEqual({ kind: "azure", selectedAccount: ACCOUNT.name, verifiedAccount: "" })
    first.unmount()

    const second = await renderChooser(draft)
    await flush()
    expect(second.container.querySelector("select")?.value).toBe(ACCOUNT.name)
    expect(second.container.textContent).toContain("Check access")
    expect(second.container.textContent).not.toContain("Access confirmed")
    expect(second.last()).toBeNull()
  })
})

describe("azureStorageBlocker", () => {
  const ready = { community: false, accountsLoaded: true, accountCount: 1, selected: true, verified: true }
  it("names the next thing that keeps Continue disabled, in order", () => {
    expect(azureStorageBlocker(ready)).toBeNull()
    expect(azureStorageBlocker({ ...ready, verified: false })).toBe("To continue, select Check access.")
    expect(azureStorageBlocker({ ...ready, selected: false, verified: false })).toBe("To continue, choose a storage account.")
    expect(azureStorageBlocker({ ...ready, accountCount: 0 })).toContain("ask an Azure administrator")
    expect(azureStorageBlocker({ ...ready, accountsLoaded: false, accountCount: 0, selected: false, verified: false })).toBe("Loading your storage accounts...")
    expect(azureStorageBlocker({ ...ready, community: true })).toContain("needs Pro or MSP")
  })
})
