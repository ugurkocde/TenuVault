import { ORGANIZATION_LICENSE_MESSAGE } from "./constants"
import { TRIAL_USED_MESSAGE } from "./constants"

export function trialKeyRefusalText(message: string): string {
  return message.replace(TRIAL_USED_MESSAGE, "This tenant already had a Pro trial.")
}

export function trialEndWhen(end: number, now = Date.now()): string {
  const date = new Date(end)
  const today = new Date(now)
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (date >= day && date < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)) return "today"
  if (date >= new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) && date < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2)) return "tomorrow"
  return `on ${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
}

export function organizationLicenseRefusal(tenant?: { trialRefusal?: string }): boolean {
  return tenant?.trialRefusal === ORGANIZATION_LICENSE_MESSAGE
}
