import { isMicrosoftLoginUrl } from "../../shared/security"

/** The two sign-ins that wait for the browser: the first sign-in to a tenant and the setup sign-in. */
export type WaitingSignIn = "signin" | "setup"

/**
 * Copies the Microsoft sign-in address the waiting sign-in opened to the clipboard, so the admin
 * can open it in another browser. The address never reaches the renderer: it only learns whether
 * there was one to copy. Anything that is not a Microsoft login address is never copied.
 */
export function copySignInLink(kind: unknown, links: Record<WaitingSignIn, () => string | null>, write: (text: string) => void): boolean {
  if (kind !== "signin" && kind !== "setup") throw new Error("Unknown sign-in.")
  const url = links[kind]()
  if (!url || !isMicrosoftLoginUrl(url)) return false
  write(url)
  return true
}
