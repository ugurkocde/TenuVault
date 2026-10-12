import { createRendererBridge } from "./plan-bridge"
import type { TenuVaultBridge, TenuVaultPreloadBridge } from "../../shared/ipc"

declare global {
  interface Window {
    tenuvault: TenuVaultPreloadBridge
  }
}

/** Main-process API exposed by the preload script. */
export const bridge: TenuVaultBridge = createRendererBridge(window.tenuvault)
