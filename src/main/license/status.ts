import type { LicenseStatus } from "../../shared/ipc"
import type { LicenseService } from "./service"

export function licenseStatusHandler(license: Pick<LicenseService, "checkTrialHealth">, currentStatus: () => LicenseStatus): () => LicenseStatus {
  return () => {
    void license.checkTrialHealth().catch(() => undefined)
    return currentStatus()
  }
}
