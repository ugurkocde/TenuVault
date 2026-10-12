import { frameworks } from "../../../shared/frameworks/catalog"
import type { NativeAssessment } from "../../../shared/compliance/native"
import type { FeatureDeps } from "../deps"

/** Frameworks with a native comparison provider, the only source of scores. */
export const NATIVE_FRAMEWORKS = frameworks.filter((framework) => framework.nativeId && !framework.disabledReason).map((framework) => ({ id: framework.id, name: framework.name }))

export function isNativeFramework(id: unknown): id is string {
  return typeof id === "string" && NATIVE_FRAMEWORKS.some((framework) => framework.id === id)
}

export interface HistoryRead {
  frameworkId: string
  frameworkName: string
  /** "unavailable" when the saved comparisons could not be read (denied, not connected, failed). */
  status: "ok" | "unavailable"
  /** Newest first, as saved. Only runs of this tenant and framework. */
  runs: NativeAssessment[]
  error: string | null
  notice: string | null
  scoringChanged?: boolean
}

function isRun(value: unknown, tenantId: string, frameworkId: string): value is NativeAssessment {
  if (!value || typeof value !== "object") return false
  const run = value as Partial<NativeAssessment>
  const assessment = run.assessment as Partial<NativeAssessment["assessment"]> | undefined
  return (
    run.schemaVersion === 1 &&
    typeof run.runId === "string" &&
    run.tenantId === tenantId &&
    run.frameworkId === frameworkId &&
    typeof run.rulesetSha256 === "string" &&
    !!assessment &&
    Array.isArray(assessment.capabilities) &&
    Array.isArray(assessment.frameworks) &&
    typeof assessment.generatedAt === "string"
  )
}

/**
 * Reads the saved native comparisons of one tenant and framework through the app's own
 * /api/frameworks route (action native-history). It never starts a collection. A failed read
 * is returned as unavailable with its message, so one denied framework or tenant does not
 * hide the others and is never shown as a result. Runs of any other tenant are dropped.
 */
export async function readHistory(deps: FeatureDeps, tenantId: string, frameworkId: string): Promise<HistoryRead> {
  const tenant = tenantId.toLowerCase()
  const frameworkName = NATIVE_FRAMEWORKS.find((framework) => framework.id === frameworkId)?.name ?? frameworkId
  const base = { frameworkId, frameworkName }
  try {
    const response = await deps.api("/api/frameworks", tenant, { action: "native-history", frameworkId })
    const body = (await response.json().catch(() => null)) as { history?: unknown; notice?: unknown; currentRunIds?: unknown; scoringChanged?: unknown; error?: unknown } | null
    if (!response.ok || !body || !Array.isArray(body.history)) {
      const error = typeof body?.error === "string" ? body.error : `Saved comparisons could not be read (${response.status}).`
      return { ...base, status: "unavailable", runs: [], error, notice: null }
    }
    return { ...base, status: "ok", runs: body.history.filter((run) => isRun(run, tenant, frameworkId) && (!Array.isArray(body.currentRunIds) || body.currentRunIds.includes(run.runId))), error: null, notice: typeof body.notice === "string" ? body.notice : null, scoringChanged: body.scoringChanged === true }
  } catch (error) {
    return { ...base, status: "unavailable", runs: [], error: error instanceof Error ? error.message : "Saved comparisons could not be read.", notice: null }
  }
}

/** Every native framework's saved comparisons for one tenant. */
export function readAllHistory(deps: FeatureDeps, tenantId: string): Promise<HistoryRead[]> {
  return Promise.all(NATIVE_FRAMEWORKS.map((framework) => readHistory(deps, tenantId, framework.id)))
}
