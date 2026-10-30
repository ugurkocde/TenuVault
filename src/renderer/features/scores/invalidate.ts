import { useEffect } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { onFrameworkJobFinished, type FrameworkJob } from "../../lib/framework-jobs"
import { onCisJobFinished, type CisJob } from "../../lib/cis-jobs"

/** Every query that shows a baseline score: the scores tab, an open score detail, the dashboard tile and the CIS cards. */
export const SCORE_QUERY_KEYS = [["scores-summary"], ["scores-detail"], ["dashboard-baseline-score"], ["scores-cis"]] as const

/**
 * Marks every score query stale and refetches the mounted ones, so a finished comparison or
 * OIB validation shows at once instead of after the queries' stale time.
 */
export function invalidateScores(client: QueryClient): void {
  for (const queryKey of SCORE_QUERY_KEYS) void client.invalidateQueries({ queryKey: [...queryKey] })
}

/** Invalidates the scores whenever a framework comparison completes; returns the unsubscribe. */
export function invalidateScoresOnComparison(client: QueryClient, subscribe: (listener: (job: FrameworkJob) => void) => () => void = onFrameworkJobFinished): () => void {
  return subscribe((job) => {
    if (job.status === "completed") invalidateScores(client)
  })
}

/** Invalidates the scores whenever a CIS pack assessment completes; returns the unsubscribe. */
export function invalidateScoresOnCisAssessment(client: QueryClient, subscribe: (listener: (job: CisJob) => void) => () => void = onCisJobFinished): () => void {
  return subscribe((job) => {
    if (job.status === "done") invalidateScores(client)
  })
}

/** Mounted once in the layout, so scores follow a finished comparison on whichever page is open. */
export function useScoreInvalidation(): void {
  const client = useQueryClient()
  useEffect(() => {
    const unsubscribeComparison = invalidateScoresOnComparison(client)
    const unsubscribeCis = invalidateScoresOnCisAssessment(client)
    return () => { unsubscribeComparison(); unsubscribeCis() }
  }, [client])
}
