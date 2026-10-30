import { describe, expect, it, vi } from "vitest"
import { WhatsNew, parseReleaseNotes } from "../src/main/whats-new"
import { memoryStore } from "./helpers"

const BODY = `## Changes

- Add the thing ([#200](https://github.com/ugurkocde/TenuVault/pull/200))
- Fix the other thing ([#201](https://github.com/ugurkocde/TenuVault/pull/201))

[Compare with 0.3.0](https://github.com/ugurkocde/TenuVault/compare/v0.3.0...v0.3.1)

## Issues resolved

- Backups stall on large tenants ([#55](https://github.com/ugurkocde/TenuVault/issues/55))

## Downloads

| Platform | Installer |
|---|---|
| Windows | [\`TenuVault-0.3.1-win.exe\`](https://example.invalid/dl) |
`

const release = (tag: string, at: string, body = BODY) => ({
  tag_name: tag,
  name: tag.replace(/^v/, ""),
  prerelease: tag.includes("-nightly."),
  draft: false,
  published_at: at,
  html_url: `https://github.com/ugurkocde/TenuVault/releases/tag/${tag}`,
  body,
})

const RELEASES = [
  release("v0.3.2-nightly.20261030031217", "2026-10-30T03:24:50Z"),
  release("v0.3.2-nightly.20261030010752", "2026-10-30T01:23:19Z"),
  release("v0.3.1", "2026-10-21T14:15:11Z"),
  release("v0.3.0", "2026-10-01T10:00:00Z"),
]

const fetchOk = () => vi.fn(async () => Response.json(RELEASES))

function service(currentVersion: string, seen?: string, fetchImpl: typeof fetch = fetchOk() as unknown as typeof fetch) {
  const store = memoryStore()
  if (seen !== undefined) store.set("app.whatsNewSeenVersion", seen)
  return { store, whatsNew: new WhatsNew(store, { currentVersion: () => currentVersion, fetchImpl }) }
}

describe("parseReleaseNotes", () => {
  it("keeps changes and issues with their links, and drops downloads", () => {
    const parsed = parseReleaseNotes(BODY)
    expect(parsed.changes).toEqual([
      { text: "Add the thing", url: "https://github.com/ugurkocde/TenuVault/pull/200", reference: "#200" },
      { text: "Fix the other thing", url: "https://github.com/ugurkocde/TenuVault/pull/201", reference: "#201" },
    ])
    expect(parsed.issues).toEqual([
      { text: "Backups stall on large tenants", url: "https://github.com/ugurkocde/TenuVault/issues/55", reference: "#55" },
    ])
  })
})

describe("WhatsNew", () => {
  it("seeds the seen version silently on first run", async () => {
    const { store, whatsNew } = service("0.3.1")
    const state = await whatsNew.state()
    expect(state.hasUnseen).toBe(false)
    expect(state.announceStable).toBe(false)
    expect(state.entries.every((entry) => !entry.unseen)).toBe(true)
    expect(store.get("app.whatsNewSeenVersion")).toBe("0.3.1")
  })

  it("lists a newer release for the pending update notes without calling it news", async () => {
    const { whatsNew } = service("0.3.0", "0.3.0")
    const state = await whatsNew.state()
    expect(state.entries.map((entry) => [entry.version, entry.installed, entry.unseen])).toEqual([
      ["0.3.1", false, false],
      ["0.3.0", true, false],
    ])
    expect(state.hasUnseen).toBe(false)
    expect(state.announceStable).toBe(false)
  })

  it("shows stable users only stable entries and announces a new stable release", async () => {
    const { whatsNew } = service("0.3.1", "0.3.0")
    const state = await whatsNew.state()
    expect(state.entries.map((entry) => entry.version)).toEqual(["0.3.1", "0.3.0"])
    expect(state.entries[0]).toMatchObject({ channel: "stable", unseen: true })
    expect(state.entries[1]!.unseen).toBe(false)
    expect(state.hasUnseen).toBe(true)
    expect(state.announceStable).toBe(true)
  })

  it("includes nightly entries for nightly users without announcing them", async () => {
    const { whatsNew } = service("0.3.2-nightly.20261030031217", "0.3.2-nightly.20261030010752")
    const state = await whatsNew.state()
    expect(state.entries.map((entry) => entry.version)).toContain("0.3.2-nightly.20261030031217")
    expect(state.entries[0]).toMatchObject({ channel: "nightly", unseen: true })
    expect(state.hasUnseen).toBe(true)
    expect(state.announceStable).toBe(false)
  })

  it("lists every skipped version between the seen and current one", async () => {
    const { whatsNew } = service("0.3.2-nightly.20261030031217", "0.3.0")
    const state = await whatsNew.state()
    expect(state.entries.filter((entry) => entry.unseen).map((entry) => entry.version)).toEqual([
      "0.3.2-nightly.20261030031217",
      "0.3.2-nightly.20261030010752",
      "0.3.1",
    ])
  })

  it("marking seen records the current version and clears the flags", async () => {
    const { store, whatsNew } = service("0.3.1", "0.3.0")
    await whatsNew.state()
    const seen = await whatsNew.markSeen()
    expect(seen.hasUnseen).toBe(false)
    expect(seen.announceStable).toBe(false)
    expect(store.get("app.whatsNewSeenVersion")).toBe("0.3.1")
  })

  it("falls back to the cached releases when GitHub cannot be reached", async () => {
    const { store, whatsNew } = service("0.3.1", "0.3.0")
    await whatsNew.state()
    const offline = new WhatsNew(store, {
      currentVersion: () => "0.3.1",
      fetchImpl: (async () => { throw new Error("offline") }) as unknown as typeof fetch,
    })
    const state = await offline.state()
    expect(state.entries.map((entry) => entry.version)).toEqual(["0.3.1", "0.3.0"])
    expect(state.error).toBeNull()
  })

  it("reports when the notes cannot be loaded at all", async () => {
    const { whatsNew } = service("0.3.1", "0.3.0", (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch)
    const state = await whatsNew.state()
    expect(state.entries).toEqual([])
    expect(state.error).toMatch(/503|could not/i)
  })
})
