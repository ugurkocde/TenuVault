import type { AppearanceSetting } from "../../shared/settings-transfer"
import { bridge } from "./bridge"

const KEY = "tenuvault-appearance"
export type Appearance = AppearanceSetting

export function getAppearance(): Appearance {
  let value: string | null = null
  try {
    value = localStorage.getItem(KEY)
  } catch {
    // Fall back to the app store below.
  }
  // Local storage can be cleared while the app store survives: keep the explicit choice it holds.
  if (value === null) {
    try {
      value = bridge.storage.getItemSync(KEY)
    } catch {
      value = null
    }
  }
  return value === "light" || value === "dark" ? value : "system"
}
export function applyAppearance(value = getAppearance()) {
  document.documentElement.classList.toggle("dark", value === "dark" || (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches))
}

function syncWindowAppearance(value: Appearance) {
  // Mirror the preference for the next window, before the renderer can paint its theme.
  if ((bridge.storage.getItemSync(KEY) ?? "system") !== value) {
    void bridge.storage.setItem(KEY, value).catch((error: unknown) => console.warn("Could not save the window appearance:", error))
  }
}

export function setAppearance(value: Appearance) {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    // Apply the new appearance for this window even if local storage is unavailable.
  }
  applyAppearance(value)
  syncWindowAppearance(value)
}

const initialAppearance = getAppearance()
applyAppearance(initialAppearance)
syncWindowAppearance(initialAppearance)
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyAppearance())
