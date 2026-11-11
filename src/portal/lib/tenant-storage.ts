/**
 * Where the tenant list is kept between page loads.
 *
 * The website keeps tenants for the browser session only. The desktop app swaps this
 * module for one backed by OS-encrypted storage (desktop/src/renderer/overrides).
 */
export const tenantStorage = {
  getItem: (key: string): string | null => sessionStorage.getItem(key),
  setItem: (key: string, value: string): void => sessionStorage.setItem(key, value),
  setItemAsync: async (key: string, value: string, _options?: { releaseRemoved?: boolean }): Promise<void> => sessionStorage.setItem(key, value),
  releaseTenant: async (_tenantId: string): Promise<void> => {},
  removeItem: (key: string): void => sessionStorage.removeItem(key),
}
