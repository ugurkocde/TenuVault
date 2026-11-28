export function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? ""
}

export function needsAccessText(names: readonly string[]): string {
  return `${listNames(names)} ${names.length === 1 ? "needs" : "need"} more access.`
}
