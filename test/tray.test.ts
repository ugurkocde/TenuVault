import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppTray, trayMenuTemplate, type TrayActions } from "../src/main/tray"

const mocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(template => template),
  setContextMenu: vi.fn(),
}))

vi.mock("electron", () => ({
  app: { getName: () => "TenuVault" },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage: vi.fn() }) },
  Tray: class {
    setContextMenu = mocks.setContextMenu
    setToolTip() {}
    on() {}
  },
}))
vi.mock("../resources/tray.png?asset", () => ({ default: "tray.png" }))
vi.mock("../resources/trayTemplate.png?asset", () => ({ default: "trayTemplate.png" }))

const actions = (): TrayActions => ({ open: vi.fn(), backUpAll: vi.fn(), nextBackup: () => null, quit: vi.fn() })
const restartNote = "Background restart may reopen TenuVault within five minutes"

describe("background runner tray notice", () => {
  beforeEach(() => vi.clearAllMocks())

  it("places a disabled restart notice directly above Quit when installed", () => {
    const menu = trayMenuTemplate(actions(), true)
    expect(menu.at(-2)).toEqual({ label: restartNote, enabled: false })
    expect(menu.at(-1)).toMatchObject({ label: "Quit TenuVault", click: expect.any(Function) })
  })

  it("leaves the note out when the runner is not installed", () => {
    const menu = trayMenuTemplate(actions(), false)
    expect(menu.some(item => item.label === restartNote)).toBe(false)
    expect(menu.at(-1)?.label).toBe("Quit TenuVault")
    expect(menu).toContainEqual({ label: "No scheduled backups", enabled: false })
  })

  it("keeps the scheduled backup summary alongside the restart notice", () => {
    const menu = trayMenuTemplate({ ...actions(), nextBackup: () => "Contoso, Mon 07:45" }, true)
    expect(menu).toContainEqual({ label: "Next backup: Contoso, Mon 07:45", enabled: false })
  })

  it("refreshes the native menu after installation and removal", () => {
    const tray = new AppTray(actions())
    tray.create()
    expect(mocks.buildFromTemplate.mock.lastCall?.[0]).not.toContainEqual({ label: restartNote, enabled: false })
    tray.setBackgroundRunnerInstalled(true)
    expect(mocks.buildFromTemplate.mock.lastCall?.[0]).toContainEqual({ label: restartNote, enabled: false })
    tray.setBackgroundRunnerInstalled(false)
    expect(mocks.buildFromTemplate.mock.lastCall?.[0]).not.toContainEqual({ label: restartNote, enabled: false })
    expect(mocks.setContextMenu).toHaveBeenCalledTimes(3)
  })
})
