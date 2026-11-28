/** Every selected row must settle, including rows whose batch has not started. */
export function directoryPageUnresolved(discarded: boolean, selection: readonly string[], outcomes: ReadonlyArray<{ key: string; state: string }>): boolean {
  if (discarded) return false
  const states = new Map(outcomes.map(row => [row.key, row.state]))
  return selection.some(key => !["applied", "blocked", "failed", "failed-before-send"].includes(states.get(key) ?? "pending"))
}
