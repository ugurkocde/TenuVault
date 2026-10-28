import type { CustomPublishOptions, GithubOptions } from "builder-util-runtime"
import type { AppUpdater } from "electron-updater"
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js"
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js"

/** The repository releases are published to, as in electron-builder.config.cjs. */
export const RELEASE_FEED: GithubOptions = { provider: "github", owner: "ugurkocde", repo: "TenuVault" }

/** Numeric parts of a release version (0.3.1) or a nightly (0.3.1-nightly.20261019063738, earlier 0.3.1-nightly.20260926.42). */
function parts(version: string): { release: number[]; nightly: number[] | null } {
  const [release = "", pre] = version.replace(/^v/, "").split("-", 2)
  return {
    release: release.split(".").map(Number),
    nightly: pre === undefined ? null : pre.split(".").slice(1).map(Number),
  }
}

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Positive when `a` is newer than `b`. A nightly comes before the stable release it previews. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a)
  const right = parts(b)
  const release = compareNumbers(left.release, right.release)
  if (release !== 0) return release
  if (left.nightly === null || right.nightly === null) return (left.nightly === null ? 1 : 0) - (right.nightly === null ? 1 : 0)
  return compareNumbers(left.nightly, right.nightly)
}

type Latest = Awaited<ReturnType<GitHubProvider["getLatestVersion"]>>

/**
 * GitHub releases for both channels. Stable follows stable releases only. Nightly follows the
 * nightly feed, but a stable release newer than the newest nightly (such as 0.3.1 over
 * 0.3.1-nightly.20261019063738) is offered as well, so turning on nightlies never holds back a
 * stable release.
 */
export class ReleaseProvider extends GitHubProvider {
  private readonly stable: GitHubProvider

  constructor(options: CustomPublishOptions, private readonly app: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super(options as unknown as GithubOptions, app, runtimeOptions)
    // The stable feed as the updater would see it with nightlies turned off.
    const stableView = Object.create(app, { channel: { value: "latest" }, allowPrerelease: { value: false } }) as AppUpdater
    this.stable = new GitHubProvider(options as unknown as GithubOptions, stableView, runtimeOptions)
  }

  // Headers the updater sets, such as its staging ID, go to both feeds.
  override setRequestHeaders(value: Parameters<GitHubProvider["setRequestHeaders"]>[0]): void {
    super.setRequestHeaders(value)
    this.stable.setRequestHeaders(value)
  }

  override async getLatestVersion(): Promise<Latest> {
    if (!this.app.allowPrerelease) return super.getLatestVersion()
    const [nightly, stable] = await Promise.allSettled([super.getLatestVersion(), this.stable.getLatestVersion()])
    if (nightly.status === "rejected") {
      if (stable.status === "fulfilled") return stable.value
      throw nightly.reason
    }
    if (stable.status === "fulfilled" && compareVersions(stable.value.version, nightly.value.version) > 0) return stable.value
    return nightly.value
  }
}
