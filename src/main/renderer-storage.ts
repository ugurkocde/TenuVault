/** Largest key the renderer may use in the encrypted app store. */
export const RENDERER_STORAGE_KEY_LIMIT = 256

/** Largest value the renderer may keep in the encrypted app store, matching the 4 MB saved drift results limit. */
export const RENDERER_STORAGE_VALUE_LIMIT = 4_000_000

/** Checks a renderer storage key before it reaches the encrypted app store. Throws on anything else. */
export function rendererStorageKey(key: unknown): string {
  if (typeof key !== "string" || !key || key.length > RENDERER_STORAGE_KEY_LIMIT) throw new Error("Invalid storage key.")
  return key
}

/** Checks a renderer storage value before it reaches the encrypted app store. Throws on anything else. */
export function rendererStorageValue(value: unknown): string {
  if (typeof value !== "string" || value.length > RENDERER_STORAGE_VALUE_LIMIT) throw new Error("The value is too large to save.")
  return value
}
