import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { BackupSettings } from "../src/shared/ipc"
import { needsRecoveryKeyExport } from "../src/renderer/lib/recovery-key"
import { RecoveryKeyNotice } from "../src/renderer/components/RecoveryKeyNotice"

vi.mock("~/contexts/TenantContext", () => ({ useTenants: () => [] }))

const settings: BackupSettings = { localFolder: "/backups", keyFingerprint: "1234-5678-9012", recoveryExported: false, hasLocalBackups: false }

describe("recovery key notice", () => {
  it("warns for a local storage target before the first backup", () => {
    expect(needsRecoveryKeyExport(settings, [undefined, "tvlocal-tenant"])).toBe(true)
    expect(needsRecoveryKeyExport({ ...settings, recoveryExported: true }, ["tvlocal-tenant"])).toBe(false)
  })

  it("warns for existing local backups even without a local storage target", () => {
    expect(needsRecoveryKeyExport({ ...settings, hasLocalBackups: true }, [])).toBe(true)
    expect(needsRecoveryKeyExport({ ...settings, hasLocalBackups: true }, ["azure-account"])).toBe(true)
    expect(needsRecoveryKeyExport({ ...settings, hasLocalBackups: true, recoveryExported: true }, [])).toBe(false)
  })

  it("warns conservatively when the local folder cannot be scanned, then hides after export", () => {
    const unknown = { ...settings, hasLocalBackups: null }
    expect(needsRecoveryKeyExport(unknown, [])).toBe(true)
    expect(needsRecoveryKeyExport(unknown, ["tvlocal-tenant"])).toBe(true)
    expect(needsRecoveryKeyExport(unknown, ["azure-account"])).toBe(true)
    expect(needsRecoveryKeyExport({ ...unknown, recoveryExported: true }, ["tvlocal-tenant"])).toBe(false)
  })

  it("does not warn while loading or when local backups are not in use", () => {
    expect(needsRecoveryKeyExport(null, ["tvlocal-tenant"])).toBe(false)
    expect(needsRecoveryKeyExport(settings, [])).toBe(false)
    expect(needsRecoveryKeyExport(settings, [undefined, "azure-account"])).toBe(false)
  })

  it("renders the warning and export link, then hides after export", () => {
    const render = (value: BackupSettings) => renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(RecoveryKeyNotice, { settings: value }),
    ))
    const local = { ...settings, hasLocalBackups: true }
    const notice = render(local)
    expect(notice).toContain('role="alert"')
    expect(notice).toContain("Starting over deletes the backup encryption key")
    expect(notice).toContain('href="/portal/settings#recovery-key"')
    expect(render({ ...local, recoveryExported: true })).toBe("")
  })
})
