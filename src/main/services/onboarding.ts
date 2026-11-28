import type { BackupScopeCoverage } from "../../shared/tenant-connection"
import { delegatedBackupCoverage } from "../../shared/services/backup-coverage"
import { checkedOnboardingChoice } from "../../shared/services/onboarding"
import { missingForChoice } from "../../shared/services/manifest"
import { grantedPermissions } from "../../shared/services/token"
import type { ModuleSettings } from "./settings"

/** Read the chosen permissions from the signed-in token, without reading or changing a registration. */
export async function checkOnboardingPermissions(value: unknown, token: () => Promise<{ accessToken: string }>): Promise<{ missing: string[]; error?: string; coverage: BackupScopeCoverage[] }> {
  const choice = checkedOnboardingChoice(value)
  try {
    const granted = grantedPermissions((await token()).accessToken)
    if (!granted || granted.kind !== "delegated") throw new Error("The permissions in the Microsoft Graph token could not be read.")
    return { missing: missingForChoice(choice, granted), coverage: delegatedBackupCoverage(granted.permissions, choice) }
  } catch (error) {
    return { missing: [], coverage: delegatedBackupCoverage(undefined, choice), error: error instanceof Error ? error.message : String(error) }
  }
}

/** Save every setting together before the tenant is added, so an Entra-only tenant never starts with Intune on. */
export function saveOnboardingServices(settings: ModuleSettings, tenantId: string, value: unknown): void {
  settings.setChoice(tenantId, checkedOnboardingChoice(value))
}
