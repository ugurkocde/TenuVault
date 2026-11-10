export function trialEndWhen(end: number, now = Date.now()): string {
  const date = new Date(end)
  const today = new Date(now)
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (date >= day && date < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)) return "today"
  if (date >= new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) && date < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2)) return "tomorrow"
  return `on ${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
}
