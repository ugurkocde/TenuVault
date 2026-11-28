// Run as a dev Electron app to prepare or verify a throwaway upgrade profile.
const { app, safeStorage } = require("electron")
const { cpSync, readFileSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")

const { TV_SMOKE_UPGRADE_MODE: mode, TV_SMOKE_UPGRADE_PROFILE: profile, TV_SMOKE_UPGRADE_FIXTURE: fixture } = process.env
app.setName("TenuVault")
app.setPath("userData", profile)

app.whenReady().then(() => {
  const encrypted = safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text")
  if (!encrypted && process.platform !== "linux") throw new Error("The runner's credential store is unavailable")
  const frozen = JSON.parse(readFileSync(join(fixture, "app-state.bin"), "utf8"))
  const state = join(profile, "app-state.bin")
  if (mode === "seed") {
    const local = join(profile, "historical-backups")
    cpSync(join(fixture, "local"), local, { recursive: true })
    const contents = JSON.stringify({ ...frozen, "backup.localFolder": local })
    writeFileSync(state, encrypted ? safeStorage.encryptString(contents) : contents, { mode: 0o600 })
  } else if (mode === "verify") {
    const contents = readFileSync(state)
    const upgraded = JSON.parse(encrypted ? safeStorage.decryptString(contents) : contents.toString("utf8"))
    if (upgraded["backup.keyring"] !== frozen["backup.keyring"]) throw new Error("Upgrade changed the historical keyring")
  } else {
    throw new Error("Expected seed or verify")
  }
  app.quit()
}).catch(error => {
  console.error(error.message)
  app.exit(1)
})
