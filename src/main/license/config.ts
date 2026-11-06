declare const __TENUVAULT_LICENSE_API_BASE__: string
declare const __TENUVAULT_LICENSE_PUBLIC_KEY__: string
declare const __TENUVAULT_LICENSE_ROTATION_KEYS__: readonly string[]
declare const __TENUVAULT_LICENSE_BUY_URL__: string
declare const __TENUVAULT_LICENSE_PORTAL_URL__: string

// Injected at build time by electron.vite.config.ts from the TENUVAULT_LICENSE_* environment variables.
export const LICENSE_API_BASE = __TENUVAULT_LICENSE_API_BASE__
/** The verification keys: the current one first, then any trusted only during a key rotation. */
export const LICENSE_PUBLIC_KEYS: readonly string[] = [__TENUVAULT_LICENSE_PUBLIC_KEY__, ...__TENUVAULT_LICENSE_ROTATION_KEYS__]
export const LICENSE_BUY_URL = __TENUVAULT_LICENSE_BUY_URL__
export const LICENSE_PORTAL_URL = __TENUVAULT_LICENSE_PORTAL_URL__

/** How often cached entitlement tokens are refreshed while the app runs. */
export const LICENSE_REFRESH_MS = 6 * 60 * 60_000
