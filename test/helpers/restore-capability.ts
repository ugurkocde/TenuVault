import { typeForFolder, type IntuneType } from "../../src/shared/intune/registry"

/**
 * Runs `run` while a registry type declares no restore capability, as a new type does. The type's
 * capability is put back afterwards, also when `run` throws.
 */
export async function withoutRestoreCapability<T>(folder: string | IntuneType, run: () => Promise<T> | T): Promise<T> {
  const type = typeof folder === "string" ? typeForFolder(folder)! : folder
  const declared = type.restore
  delete type.restore
  try {
    return await run()
  } finally {
    if (declared) type.restore = declared
  }
}
