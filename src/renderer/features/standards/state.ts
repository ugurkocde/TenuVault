/** Which of the mutually exclusive library states the Standards tab shows. */
export type StandardsViewState = "loading" | "error" | "empty" | "ready"

export function standardsViewState(input: { isLoading: boolean; hasError: boolean; standardsCount: number; adoptionsCount: number }): StandardsViewState {
  if (input.isLoading) return "loading"
  if (input.hasError) return "error"
  if (input.standardsCount === 0 && input.adoptionsCount === 0) return "empty"
  return "ready"
}
