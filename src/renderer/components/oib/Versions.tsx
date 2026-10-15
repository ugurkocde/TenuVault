import { useContext, useState } from "react"
import { cn } from "~/lib/utils"
import { OIB_PLATFORMS, type OibPlatform, type OibVersions } from "../../../shared/oib/types"
import { defaultSelection, isPrerelease, platformReleases } from "../../../shared/oib/versions"
import { button, platformsLabel, primary, Toggle, VersionPicker, versionsLabel, VersionsContext, type Selections } from "./common"

const ALL = Object.keys(OIB_PLATFORMS) as OibPlatform[]

export { VersionsContext }
export type { OibVersionChoice } from "./common"

/** "Windows v4.0, macOS v1.0 and BYOD main" for the platforms given (all when empty). */
export const selectionsLabel = (selections: Selections, platforms: OibPlatform[] = []) =>
  versionsLabel((platforms.length ? platforms : ALL).map(platform => ({ platform, tag: selections[platform].tag })))

/** Whether a platform's selected release is a prerelease (published unstable releases are not). */
const selectedPrerelease = (versions: OibVersions, selections: Selections, platform: OibPlatform) => {
  const tag = selections[platform].tag
  const release = tag ? versions.releases.find(r => r.platform === platform && r.tag === tag) : undefined
  return release ? isPrerelease(release) : false
}

/** Notes about main (unreleased changes, platforms without a release) and prerelease channel selections. */
export function mainNotes(versions: OibVersions, selections: Selections, platforms: OibPlatform[] = []) {
  const scope = platforms.length ? platforms : ALL
  const onMain = scope.filter(p => !selections[p].tag)
  // Main is flagged only when it differs from every release of a platform that has releases.
  const unreleased = onMain.filter(p => platformReleases(versions, p).length && !platformReleases(versions, p).some(r => r.commit === selections[p].commit))
  const only = onMain.filter(p => !platformReleases(versions, p).length)
  const prerelease = scope.filter(p => selectedPrerelease(versions, selections, p))
  const mainWarning = unreleased.length ? `${platformsLabel(unreleased)} ${unreleased.length === 1 ? "uses" : "use"} main, which can hold changes that are not released yet. Test in a pilot tenant first.` : ""
  const prereleaseWarning = prerelease.length ? `${platformsLabel(prerelease)} ${prerelease.length === 1 ? "uses a prerelease" : "use prereleases"}, which are not production-ready. Test in a pilot tenant first.` : ""
  return {
    warning: [mainWarning, prereleaseWarning].filter(Boolean).join(" "),
    info: only.length ? `${platformsLabel(only)}: main (no published release yet).` : "",
  }
}

/** Version selects with a prerelease toggle, Use latest releases, Cancel and Done; nothing applies before Done. */
export function VersionsPanel({ versions, selections, onDone, onCancel, className, allowPrerelease, onAllowPrereleaseChange }: { versions: OibVersions; selections: Selections; onDone: (value: Selections) => void; onCancel: () => void; className?: string; allowPrerelease: boolean; onAllowPrereleaseChange: (value: boolean) => void }) {
  const [draft, setDraft] = useState(selections)
  // The toggle is part of the draft like the selects: Cancel must not change it.
  const [draftPrerelease, setDraftPrerelease] = useState(allowPrerelease)
  const applyLatest = (prerelease: boolean) => setDraft(Object.fromEntries(ALL.map(p => [p, defaultSelection(versions, p, prerelease)])) as Selections)
  return <div className={cn("rounded-2xl border border-gray-200 bg-white p-5", className)} role="group" aria-label="OpenIntuneBaseline versions">
    <p className="mb-4 text-sm text-gray-600">Each platform uses its latest published release unless you choose another. Older releases have fewer or older policies; main includes changes that are not released yet. Platforms without a published release use main, or their beta release where that is the only release.</p>
    <VersionPicker versions={versions} value={draft} onChange={setDraft} allowPrerelease={draftPrerelease} />
    <div className="mt-4">
      <Toggle checked={draftPrerelease} onChange={value => { setDraftPrerelease(value); applyLatest(value) }} label="Include beta prereleases">
        Offers beta baselines as each platform's latest version. These are not production-ready. Use them only to evaluate upcoming changes in a pilot tenant.
      </Toggle>
    </div>
    <div className="mt-4 flex flex-wrap justify-end gap-3">
      <button type="button" className={button} onClick={() => applyLatest(draftPrerelease)}>Use latest releases</button>
      <button type="button" className={button} onClick={onCancel}>Cancel</button>
      <button type="button" className={primary} onClick={() => { onAllowPrereleaseChange(draftPrerelease); onDone(draft) }}>Done</button>
    </div>
  </div>
}

/**
 * The versions a workflow uses, with an inline Change versions for its first step (before anything
 * is loaded). Applying new versions restarts the workflow at its first step.
 */
export function ChangeVersions({ platforms = [], disabled }: { platforms?: OibPlatform[]; disabled?: boolean }) {
  const choice = useContext(VersionsContext)
  const [open, setOpen] = useState(false)
  if (!choice) return null
  const { versions, selections, choose, allowPrerelease, setAllowPrerelease } = choice
  const notes = mainNotes(versions, selections, platforms)
  return <div className="mt-5 text-sm text-gray-600">
    <p>Versions: {selectionsLabel(selections, platforms)}.{" "}
      {!open && <button type="button" className="text-blue-700 underline disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => setOpen(true)}>Change versions</button>}
    </p>
    {notes.info && <p className="mt-1 text-xs text-gray-500">{notes.info}</p>}
    {notes.warning && <p role="status" className="mt-1 text-xs text-amber-900">{notes.warning}</p>}
    {open && <VersionsPanel className="mt-3" versions={versions} selections={selections} allowPrerelease={allowPrerelease} onAllowPrereleaseChange={setAllowPrerelease} onCancel={() => setOpen(false)} onDone={value => { setOpen(false); choose(value) }} />}
  </div>
}
