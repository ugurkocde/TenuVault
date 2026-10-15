import { OIB_PLATFORMS, type OibChannel, type OibPlatform, type OibPlatformStatus, type OibPublishedRelease, type OibSelection, type OibVersions } from "./types"

/**
 * Release identifiers name their platform and version: stable tags like windows-v4.0 or
 * macos-v1.0, and beta branches like macos-v2.0-beta or ios-v1.0-beta.
 */
export const RELEASE_TAG = /^(windows|macos|win365|byod|ios|android)-v(\d+(?:\.\d+){0,3})(?:-([a-z]+))?$/i

/** The platform a release tag or branch belongs to, or undefined for identifiers that are not releases. */
export function tagPlatform(tag: string): OibPlatform | undefined {
  return RELEASE_TAG.exec(tag)?.[1]!.toLowerCase() as OibPlatform | undefined
}

/** "v4.0" for windows-v4.0 and macos-v2.0-beta alike. */
export function tagVersion(tag: string): string | undefined {
  const version = RELEASE_TAG.exec(tag)?.[2]
  return version ? `v${version}` : undefined
}

/** The channel a beta branch encodes in its suffix (macos-v2.0-beta); undefined for plain tags. */
export function tagChannel(tag: string): OibChannel | undefined {
  const suffix = RELEASE_TAG.exec(tag)?.[3]?.toLowerCase()
  return suffix === "beta" || suffix === "unstable" ? suffix : undefined
}

/** The releases of a platform, newest first; prereleases are left out unless asked for. */
export function platformReleases(versions: OibVersions, platform: OibPlatform, allowPrerelease = true): OibPublishedRelease[] {
  return versions.releases.filter((release) => release.platform === platform && (allowPrerelease || !release.prerelease))
}

/** The status the manifest gives a platform; platforms the manifest omits are treated as in development. */
export function platformStatus(versions: OibVersions, platform: OibPlatform): OibPlatformStatus {
  return versions.platforms.find((entry) => entry.platform === platform)?.status ?? "in-development"
}

/**
 * The version a platform uses unless the admin picks another: its newest release, else main.
 * Beta and unstable prereleases are only chosen by default when prereleases are allowed.
 */
export function defaultSelection(versions: OibVersions, platform: OibPlatform, allowPrerelease = false): OibSelection {
  const latest = platformReleases(versions, platform, allowPrerelease)[0]
  return latest ? { commit: latest.commit, tag: latest.tag } : { commit: versions.main.commit }
}

/** Short label for a selection: "v4.0", "v2.0 beta" for a beta branch, "main @ 1cc71a9" otherwise. */
export function selectionLabel(selection: OibSelection): string {
  if (!selection.tag) return `main @ ${selection.commit.slice(0, 7)}`
  const version = tagVersion(selection.tag) ?? selection.tag
  const channel = tagChannel(selection.tag)
  return channel ? `${version} ${channel}` : version
}

/**
 * The reference recorded with runs, comparisons and baselines, for example
 * "OpenIntuneBaseline Windows v4.0 · windows-v4.0 @ 1cc71a9" or "OpenIntuneBaseline macOS · main @ 1cc71a9".
 */
export function oibReference(platform: OibPlatform, commit: string, tag?: string, manifestVersion?: string): string {
  const version = (tag && tagVersion(tag)) ?? manifestVersion
  const channel = tag ? tagChannel(tag) : undefined
  const label = version ? `${version}${channel ? ` ${channel}` : ""}` : ""
  return `OpenIntuneBaseline ${OIB_PLATFORMS[platform].label}${label ? ` ${label}` : ""} · ${tag ?? "main"} @ ${commit.slice(0, 7)}`
}
