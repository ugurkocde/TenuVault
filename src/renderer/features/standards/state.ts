/** Which of the mutually exclusive library states the Standards tab shows. */
export type StandardsViewState = "loading" | "error" | "empty" | "ready"

export function standardsViewState(input: { isLoading: boolean; hasError: boolean; standardsCount: number; adoptionsCount: number }): StandardsViewState {
  if (input.isLoading) return "loading"
  if (input.hasError) return "error"
  if (input.standardsCount === 0 && input.adoptionsCount === 0) return "empty"
  return "ready"
}

/**
 * The deviation of an adoption as the Standards tab shows it. Deviations are unknown, never
 * zero, when the count is missing or some policies could not be assessed: those policies may
 * deviate too.
 */
export function deviationLabel(state: { freshness: "fresh" | "stale" | "unknown"; deviations: number | null; unknownPolicies: number | null }): { text: string; tone: "success" | "warning" } {
  if (state.freshness === "unknown") return { text: "deviation not assessed", tone: "warning" }
  if (state.freshness === "stale") return { text: "assessment stale", tone: "warning" }
  if (state.deviations === null) return { text: "deviation unknown", tone: "warning" }
  const count = `${state.deviations} deviation${state.deviations === 1 ? "" : "s"}`
  if (state.unknownPolicies) return { text: state.deviations ? `${count}, ${state.unknownPolicies} ${state.unknownPolicies === 1 ? "policy" : "policies"} unknown` : `deviation unknown for ${state.unknownPolicies} ${state.unknownPolicies === 1 ? "policy" : "policies"}`, tone: "warning" }
  return { text: count, tone: state.deviations ? "warning" : "success" }
}
