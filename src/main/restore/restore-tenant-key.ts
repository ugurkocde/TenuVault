/** One case-insensitive tenant identity for restore storage keys and prefix checks. */
export const restoreTenantKey = (tenant: string): string => tenant.toLowerCase()
