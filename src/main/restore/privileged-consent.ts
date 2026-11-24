import { APPLICATION_REVIEW_FOLDERS, PRIVILEGED_REVIEW_FOLDERS } from "../../shared/intune/directory-review-folders"
import { PRIVILEGED_ENTRA_PACK } from "../../shared/services/permission-packs"
import type { SignInMethod } from "../../shared/tenant-connection"

/** Called only at execution, after the saved preview and the local owner are verified. */
export function privilegedRestoreConsent(method: SignInMethod | undefined, folder: string) {
  if (method !== "tenuvaultApp" || ![...APPLICATION_REVIEW_FOLDERS, ...PRIVILEGED_REVIEW_FOLDERS].includes(folder)) return null
  return {
    pack: PRIVILEGED_ENTRA_PACK,
    cleanup: { label: "Remove this permission", checked: true, operationScopesOnly: true, required: true },
  } as const
}
