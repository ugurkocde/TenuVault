/** App Backup is free on every plan and does not depend on license status or Community tenant selection; only a restore into another tenant checks that tenant's plan. */
export const isAppBackupPath = (path: string): boolean => path === "/portal/app-backup" || path.startsWith("/portal/app-backup/")

/** App Backup tabs share the same operation workspace and error boundary. */
export const desktopRouteBoundaryKey = (path: string): string => isAppBackupPath(path) ? "/portal/app-backup" : path
