/** App Backup is free and does not depend on license status or Community tenant selection. */
export const isAppBackupPath = (path: string): boolean => path === "/portal/app-backup" || path.startsWith("/portal/app-backup/")
