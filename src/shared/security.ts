export function sameRendererDocument(candidate: string, expected: string): boolean {
  try {
    const actual = new URL(candidate)
    const allowed = new URL(expected)
    actual.hash = ''
    allowed.hash = ''
    return actual.href === allowed.href
  } catch { return false }
}

export function csvCell(value: unknown): string {
  let text = String(value ?? '')
  if (/^(?:[\t\r]|\s*[=+@-])/.test(text)) text = `'${text}`
  const escaped = text.replace(/"/g, '""')
  return /[,\r\n"]/.test(escaped) ? `"${escaped}"` : escaped
}

export function assertArmPage(url: string, seen: Set<string>): void {
  const parsed = new URL(url)
  if (parsed.origin !== 'https://management.azure.com' || parsed.username || parsed.password || parsed.hash || seen.has(parsed.href) || seen.size >= 1000) {
    throw new Error('Invalid or repeated Azure continuation link')
  }
  seen.add(parsed.href)
}

/** Whether `url` is an https URL on the Microsoft login host, the only place sign-in may open. */
export function isMicrosoftLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'login.microsoftonline.com' && !parsed.username && !parsed.password
  } catch { return false }
}

export function isGuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
}

/**
 * Intune object IDs as Graph returns them: GUIDs, GUID_suffix forms such as `<guid>_DefaultLimit`,
 * prefixed app protection IDs such as `T_<guid>`, and numeric scope tag IDs. Excludes every character
 * that could leave a URL path segment or an OData key literal.
 */
export function isGraphId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][\w.:=+~!-]{0,255}$/.test(value) && !value.includes('..')
}

/** Encodes a blob name one path segment at a time and rejects dot segments, which URLs resolve away. */
export function blobPath(name: string): string {
  const segments = name.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error('Invalid blob name')
  return segments.map(encodeURIComponent).join('/')
}

/** A relative archive entry name without dot segments, drive letters or a leading separator. */
export function isSafeArchivePath(name: string): boolean {
  return name.length > 0 && !/^[\\/]|^[A-Za-z]:/.test(name) && !name.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')
}
