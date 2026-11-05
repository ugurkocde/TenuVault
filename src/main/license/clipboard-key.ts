/**
 * A TenuVault license key copied from the trial email, or null. Only text that is a key and
 * nothing else counts, so other clipboard content never reaches the renderer.
 */
export function licenseKeyFromClipboard(text: unknown): string | null {
  if (typeof text !== "string" || text.length > 512) return null
  const trimmed = text.trim()
  return /^TENU-[A-Za-z0-9-]{4,123}$/.test(trimmed) ? trimmed : null
}
