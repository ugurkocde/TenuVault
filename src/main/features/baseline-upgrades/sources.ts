import type { BaselinePolicy } from "../../../shared/frameworks/policies"
import type { OibPlatform, OibRun } from "../../../shared/oib/types"
import { loadWorkspace } from "../../frameworks/workspaces"
import { listRuns } from "../../oib/service"
import { oibPack, oibReleases, rememberCommit, type OibPack, type OibRelease } from "../../oib/source"

/**
 * Where installed baselines come from: OpenIntuneBaseline deployment runs (platform, exact
 * commit and the IDs they created or updated, including runs migrated from Quick Start) and
 * framework workspaces (a stored pack and its reference). Injected so tests replace GitHub and
 * the app store; the defaults read the existing run and workspace storage and never write to it.
 */
export interface BaselineSources {
  runs: (tenantId: string) => OibRun[]
  /** The latest OpenIntuneBaseline main commit, as the one release of every platform. */
  releases: () => Promise<{ releases: OibRelease[]; warning?: string }>
  /**
   * Loads an OIB pack at a commit resolved in this session. `recorded` marks a commit read from
   * the app's own records (a deployment run), which may be loaded again after a restart.
   * Only Customize supplies `releaseTag`, keeping release admission out of other consumers.
   */
  pack: (platform: OibPlatform, commit: string, recorded?: boolean, releaseTag?: string) => Promise<OibPack>
  workspace: (tenantId: string, frameworkId: string) => { policies: BaselinePolicy[]; reference: string; creations: Array<{ name: string; id?: string }> }
}

export const defaultSources: BaselineSources = {
  // Assignment runs change who gets deployed policies; they install nothing.
  runs: (tenantId) => listRuns(tenantId).filter((run) => run.kind !== "assign"),
  releases: () => oibReleases(),
  pack: (platform, commit, recorded, releaseTag) => {
    if (recorded) rememberCommit(commit)
    return oibPack(platform, commit, releaseTag)
  },
  workspace: (tenantId, frameworkId) => {
    const workspace = loadWorkspace(tenantId, frameworkId)
    const creations = workspace.history.flatMap((entry) => entry.creation?.results ?? [])
    return { policies: workspace.policies, reference: workspace.reference, creations }
  },
}

/**
 * The exact commit a deployment run used. Runs record it; Quick Start runs migrated from earlier
 * versions have it only when they used the pinned release. Null means the provenance is unknown.
 */
export function resolveRunCommit(run: Pick<OibRun, "commit">): string | null {
  return typeof run.commit === "string" && /^[0-9a-f]{40}$/.test(run.commit) ? run.commit : null
}

/**
 * Whether a release is worth offering over the installed one: another commit, unless the
 * installed reference names a strictly newer version. Main commits carry no version of their
 * own, so a different main commit is offered.
 */
export function offeredOver(release: Pick<OibRelease, "commit" | "reference">, installed: { commit: string | null; reference: string }): boolean {
  return release.commit !== installed.commit && !newerVersion(installed.reference, release.reference)
}

/** The version in a release reference or tag, as numbers, for ordering releases. */
export function versionOf(tagOrReference: string): number[] | null {
  const match = /v(\d+(?:\.\d+){0,3})/i.exec(tagOrReference)
  return match ? match[1]!.split(".").map(Number) : null
}

/** Whether version a is newer than b; unknown versions are never newer. */
export function newerVersion(a: string, b: string): boolean {
  const [x, y] = [versionOf(a), versionOf(b)]
  if (!x || !y) return false
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0)
    if (difference) return difference > 0
  }
  return false
}
