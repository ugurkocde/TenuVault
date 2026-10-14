import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"

// Electron 44 no longer downloads its binary when it is installed, so dev and preview fetch it
// first. A developer who points electron-vite at an existing Electron with ELECTRON_EXEC_PATH
// needs no download, which also keeps an offline start working.
if (!process.env.ELECTRON_EXEC_PATH) {
  execFileSync(process.execPath, [createRequire(import.meta.url).resolve("electron/install.js")], { stdio: "inherit" })
}
