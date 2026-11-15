import { withAppLinkSource } from "./link-source"

/** The page that explains the free setup call and holds the calendar. Every mention in the app opens it. */
export const SETUP_CALL_URL = "https://www.tenuvault.com/setup-call"

/** The screens that offer the call. The page receives the name as `src=app-<source>`. */
export type SetupCallSource =
  | "welcome"
  | "setup-header"
  | "signin-waiting"
  | "setup-error"
  | "signin-error"
  | "first-backup-error"
  | "support"

/** The link for one screen. It names the screen and carries no identifier. */
export function setupCallUrl(source: SetupCallSource): string {
  return withAppLinkSource(SETUP_CALL_URL, source)
}
