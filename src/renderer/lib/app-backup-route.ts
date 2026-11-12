/** App Backup is free and does not depend on license status or Community tenant selection. */
export const isAppBackupPath = (path: string): boolean => path === "/portal/app-backup" || path.startsWith("/portal/app-backup/")

/** App Backup tabs share the same operation workspace and error boundary. */
export const desktopRouteBoundaryKey = (path: string): string => isAppBackupPath(path) ? "/portal/app-backup" : path
