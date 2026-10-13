import type { RouteModule } from "../../api/host"
import type { SignalProvider, WorkSignal } from "../contracts"
import type { FeatureDeps } from "../deps"
import { featureRoute, FeatureError, optionalText, type Body } from "../route"
import { SCORE_FORMULA, STALE_AFTER_DAYS } from "./formula"
import { isNativeFramework, readAllHistory, readHistory } from "./history"
import { frameworkDetail, frameworkScore, type FrameworkScore } from "./view"
import { oibFrameworkDetail, oibFrameworkScore, oibScorePlatform, readOibHistory } from "./oib"

async function tenantScores(deps: FeatureDeps, tenantId: string): Promise<FrameworkScore[]> {
  const now = deps.now()
  const [native, oib] = await Promise.all([readAllHistory(deps, tenantId), readOibHistory(deps, tenantId)])
  return [...native.map((read) => frameworkScore(read, now)), ...oib.map((read) => oibFrameworkScore(read, now))]
}

function frameworkIdOf(body: Body): string {
  const id = body.frameworkId
  if (!isNativeFramework(id) && !(typeof id === "string" && oibScorePlatform(id))) throw new FeatureError("Choose a framework with a saved comparison or OIB validation.")
  return id
}

/**
 * /api/scores (#137): scores projected from saved native comparisons and OIB validations.
 * Nothing here collects from Microsoft Graph or stores results; every answer is computed from
 * the comparisons the Frameworks page saved. There are no stored score records, so after a
 * downgrade the saved comparisons stay available on the Frameworks page and this screen shows
 * its locked preview only.
 */
export function routes(deps: FeatureDeps): Record<string, RouteModule> {
  return featureRoute("/api/scores", deps, {
    summary: async ({ tenantId, deps }) => {
      const now = deps.now()
      const [native, oib] = await Promise.all([readAllHistory(deps, tenantId), readOibHistory(deps, tenantId)])
      return {
        tenantId,
        tenantName: deps.tenant(tenantId)?.name ?? null,
        formula: SCORE_FORMULA,
        staleAfterDays: STALE_AFTER_DAYS,
        scoringChanged: native.some(read => read.scoringChanged),
        frameworks: [...native.map(read => frameworkScore(read, now)), ...oib.map(read => oibFrameworkScore(read, now))],
      }
    },

    detail: async ({ tenantId, body, deps }) => {
      const frameworkId = frameworkIdOf(body)
      const runId = optionalText(body, "runId", 100)
      const platform = oibScorePlatform(frameworkId)
      if (platform) {
        const read = (await readOibHistory(deps, tenantId)).find((entry) => entry.platform === platform)!
        if (read.error) throw new FeatureError(read.error, 502)
        const run = runId ? read.runs.find((entry) => entry.runId === runId) : [...read.runs].sort((a, b) => Date.parse(b.validatedAt) - Date.parse(a.validatedAt))[0]
        if (!run) throw new FeatureError("Saved OIB validation not found.", 404)
        return { tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, detail: oibFrameworkDetail(run, deps.now()) }
      }
      const read = await readHistory(deps, tenantId, frameworkId)
      if (read.status === "unavailable") throw new FeatureError(read.error ?? "Saved comparisons could not be read.", 502)
      const run = runId ? read.runs.find((item) => item.runId === runId) : read.runs[0]
      if (!run) throw new FeatureError(runId ? "Saved comparison not found." : "No saved comparison for this framework.", 404)
      return { tenantId, tenantName: deps.tenant(tenantId)?.name ?? null, detail: frameworkDetail(run, deps.now()) }
    },

    // MSP: the selected tenant plus the licensed tenants the renderer names. Each tenant is
    // read on its own, so a denied or failed tenant is reported without hiding the others.
    "portfolio-summary": async ({ tenantId, targetTenants, deps }) => {
      const tenants = [tenantId, ...targetTenants]
      const rows = await Promise.all(tenants.map(async (id) => {
        try {
          const frameworks = await tenantScores(deps, id)
          return {
            tenantId: id,
            tenantName: deps.tenant(id)?.name ?? null,
            error: null,
            frameworks: frameworks.map(({ frameworkId, frameworkName, state, message, latest }) => ({
              frameworkId,
              frameworkName,
              state,
              message,
              score: latest?.score.score ?? null,
              coverage: latest?.score.coverage ?? null,
              unknown: latest?.score.counts.unknown ?? null,
              gapCount: latest?.gapCount ?? null,
              assessedAt: latest?.freshness.assessedAt ?? null,
              ageDays: latest?.freshness.ageDays ?? null,
              stale: latest?.freshness.stale ?? null,
              partial: latest ? latest.incompleteCollection.length > 0 : null,
              version: latest ? `${latest.identity.frameworkVersion}, ${latest.identity.profile}` : null,
            })),
          }
        } catch (error) {
          return { tenantId: id, tenantName: deps.tenant(id)?.name ?? null, error: error instanceof Error ? error.message : "Scores could not be read.", frameworks: [] }
        }
      }))
      return { formula: SCORE_FORMULA, tenants: rows }
    },
  })
}

/**
 * Stale saved scores: a framework whose latest saved comparison or validation is older
 * than STALE_AFTER_DAYS. Frameworks that were never assessed stay silent here; the scores
 * screen already reports them, and a missing score is not evidence of a stale one. A
 * framework whose saved comparisons could not be read fails the provider instead, so the
 * caller marks the signals family as not evaluated and older stale findings stay as they
 * were: unreadable evidence must never read as "no stale scores".
 */
export async function scoreSignals(deps: FeatureDeps, tenantId: string): Promise<WorkSignal[]> {
  const tenant = tenantId.toLowerCase()
  const scores = await tenantScores(deps, tenant)
  const unreadable = scores.find((entry) => entry.state === "unavailable")
  if (unreadable) throw new Error(unreadable.message ?? "Saved scores could not be read.")
  return scores.flatMap((entry): WorkSignal[] => {
    if (!entry.latest || !entry.latest.freshness.stale) return []
    const age = entry.latest.freshness.ageDays
    return [{
      key: `score-stale:${entry.frameworkId}`,
      tenantId: tenant,
      source: "score",
      severity: "low",
      state: "unknown",
      title: `Baseline score for ${entry.frameworkName} is stale`,
      reason: `Last assessed ${entry.latest.freshness.assessedAt}${age === null ? "" : `, ${age} days ago`}; scores older than ${STALE_AFTER_DAYS} days are stale. Run a new comparison on the Frameworks page.`,
      observedAt: entry.latest.freshness.assessedAt,
      link: "/portal/governance/scores",
      evidence: [],
    }]
  })
}

/** Background work while the app runs; scores need none. */
export function start(_deps: FeatureDeps): () => void {
  return () => undefined
}

/** Stale saved scores for one tenant. */
export const signals: SignalProvider = (deps, tenantId) => scoreSignals(deps, tenantId)
