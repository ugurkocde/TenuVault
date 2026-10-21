import { afterEach, describe, expect, it, vi } from "vitest"
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js"
import { compareVersions, RELEASE_FEED, ReleaseProvider } from "../src/main/update-provider"

describe("release version order", () => {
  it("orders releases, nightlies and the stable release a nightly previews", () => {
    expect(compareVersions("0.3.1", "0.3.0")).toBeGreaterThan(0)
    expect(compareVersions("0.3.1", "0.3.1-nightly.20261019063738")).toBeGreaterThan(0)
    expect(compareVersions("0.3.2-nightly.20261022080000", "0.3.1")).toBeGreaterThan(0)
    expect(compareVersions("0.3.1-nightly.20261019063738", "0.3.1-nightly.20261019061209")).toBeGreaterThan(0)
    expect(compareVersions("0.1.1-nightly.20260926181500", "0.1.1-nightly.20260926.42")).toBeGreaterThan(0)
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareVersions("v0.3.1", "0.3.1")).toBe(0)
  })
})

type Feed = { nightly: string | Error; stable: string | Error }

/** A provider whose GitHub lookups answer from `feed`: the nightly feed for the updater, latest.yml for the stable view. */
function provider(feed: Feed, allowPrerelease = true) {
  vi.spyOn(GitHubProvider.prototype, "getLatestVersion").mockImplementation(async function (this: GitHubProvider) {
    const updater = (this as unknown as { updater: { channel: string | null; allowPrerelease: boolean } }).updater
    const answer = updater.allowPrerelease && updater.channel === "nightly" ? feed.nightly : updater.channel === "latest" && !updater.allowPrerelease ? feed.stable : new Error("unexpected feed")
    if (answer instanceof Error) throw answer
    return { version: answer, tag: `v${answer}`, files: [], path: "", sha512: "", releaseDate: "" }
  })
  const updater = { channel: allowPrerelease ? "nightly" : "latest", allowPrerelease }
  return new ReleaseProvider({ ...RELEASE_FEED, provider: "custom" }, updater as never, { executor: {} } as never)
}

describe("release provider", () => {
  afterEach(() => vi.restoreAllMocks())

  it("offers a stable release newer than the newest nightly on the nightly channel", async () => {
    const latest = await provider({ nightly: "0.3.1-nightly.20261019063738", stable: "0.3.1" }).getLatestVersion()
    expect(latest.version).toBe("0.3.1")
    expect(latest.tag).toBe("v0.3.1")
  })

  it("keeps the nightly when it previews a newer version than the stable release", async () => {
    expect((await provider({ nightly: "0.3.2-nightly.20261022080000", stable: "0.3.1" }).getLatestVersion()).version).toBe("0.3.2-nightly.20261022080000")
  })

  it("falls back to whichever feed answered", async () => {
    expect((await provider({ nightly: "0.3.2-nightly.20261022080000", stable: new Error("offline") }).getLatestVersion()).version).toBe("0.3.2-nightly.20261022080000")
    expect((await provider({ nightly: new Error("no nightly"), stable: "0.3.1" }).getLatestVersion()).version).toBe("0.3.1")
    await expect(provider({ nightly: new Error("no nightly"), stable: new Error("offline") }).getLatestVersion()).rejects.toThrow("no nightly")
  })

  it("only asks the stable feed on the stable channel", async () => {
    expect((await provider({ nightly: "0.3.2-nightly.20261022080000", stable: "0.3.1" }, false).getLatestVersion()).version).toBe("0.3.1")
  })

  it("sends the updater's request headers to both feeds", () => {
    const set = vi.spyOn(GitHubProvider.prototype, "setRequestHeaders")
    provider({ nightly: "0.3.1-nightly.20261019063738", stable: "0.3.1" }).setRequestHeaders({ "x-user-staging-id": "id" })
    expect(set).toHaveBeenCalledTimes(2)
  })
})
