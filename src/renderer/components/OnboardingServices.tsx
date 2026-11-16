import { INTUNE_TYPES } from "../../shared/intune/registry"
import { Button } from "~/components/ui/button"
import { MODULE_BY_ID, type ModuleId } from "../../shared/services/modules"
import { areaPermissions, BASE_PERMISSIONS, REQUEST_ORDER, type PermissionChoice } from "../../shared/services/manifest"
import { canRequestRestore, choiceLabel, onboardingPermissions, PERSONAL_DATA } from "../../shared/services/onboarding"

const isWrite = (name: string) => /(?:^|\.)(?:ReadWrite|Write|Manage)(?:\.|$)/.test(name)
const counts = (permissions: readonly string[]) => `${permissions.filter(name => !isWrite(name)).length} read, ${permissions.filter(isWrite).length} write`

const DESCRIPTIONS = {
  intune: "Policies, apps, scripts, enrollment and tenant settings.",
  entra: "Tenant settings, sign-in policies, identity access and governance.",
  defender: "Detection rules, email security, identity and posture settings.",
}
const COVERAGE: Record<string, string> = {
  "entra:tenantSettings": "Tenant policies, branding and domains",
  "entra:authentication": "Sign-in policies and authentication settings",
  "entra:externalIdentities": "Guest access, identity providers and user flows",
  "entra:roles": "Directory roles, privileged access and administrative units",
  "entra:governance": "Access packages, reviews and lifecycle workflows",
  "defender:detection": "Custom detection rules and case settings",
  "defender:email": "Attack simulation configuration and submission policies",
  "defender:identity": "Identity sensors and automatic auditing settings",
  "defender:posture": "Secure Score settings and security roles",
}

function permissionAreas(id: ModuleId, picked: NonNullable<PermissionChoice[ModuleId]>) {
  return MODULE_BY_ID.get(id)!.areas.filter(area => !area.optIn || picked.areas?.includes(area.id)).map(area => ({
    ...area, permissions: areaPermissions(area, picked.access, "delegated"),
  }))
}

export function OnboardingServices({ choice, onChange, onContinue }: { choice: PermissionChoice; onChange: (choice: PermissionChoice) => void; onContinue: () => void }) {
  const toggle = (id: ModuleId, enabled: boolean) => {
    const next = { ...choice }
    if (enabled) next[id] = { access: MODULE_BY_ID.get(id)!.defaultAccess }
    else delete next[id]
    onChange(next)
  }
  const permissionsChoice = onboardingPermissions(choice)
  return <div className="space-y-4">
    <div><h2 id="setup-step--1" tabIndex={-1} className="text-2xl font-medium tracking-tight text-gray-900">What do you want to back up?</h2>
      <p className="mt-2 text-sm text-gray-600">Choose services for this tenant. Review permissions below, or keep the defaults and continue.</p></div>
    <div className="grid items-start gap-3 lg:grid-cols-3">
      {(["intune", "entra", "defender"] as const).map(id => {
        const module = MODULE_BY_ID.get(id)!
        const picked = choice[id]
        const areas = permissionAreas(id, picked ?? { access: module.defaultAccess })
        const permissions = [...new Set(areas.flatMap(area => area.permissions))]
        return <section key={id} data-onboarding-service={id} className={`min-w-0 rounded-2xl border p-4 ${picked ? "border-blue-300 bg-blue-50/60" : "border-border"}`}>
          <label data-no-select className="flex items-center justify-between gap-3 font-medium text-gray-900">{module.label}
            <input type="checkbox" aria-label={`Back up ${module.label}`} checked={Boolean(picked)} onChange={event => toggle(id, event.target.checked)} className="size-4 accent-primary" /></label>
          <p className="mt-3 text-sm text-gray-600">{DESCRIPTIONS[id]}</p>
          {!areas.some(area => area.folders.some(folder => INTUNE_TYPES.some(type => type.folder === folder))) && <p className="mt-3 text-sm font-medium text-gray-700">Permissions setup only. Backups arrive later.</p>}
          <p className="mt-3 text-xs font-medium text-gray-700" data-permission-count>{counts(permissions)} permissions{!picked && " if selected"}</p>
          <details className="mt-3" data-choice-details>
            <summary className="cursor-pointer text-sm font-medium text-blue-700">Coverage and permissions</summary>
            <div className="mt-3 max-h-40 space-y-3 overflow-y-auto overscroll-contain pr-1 text-xs text-gray-600" role="region" tabIndex={0} aria-label={`${module.label} coverage`}>
              <ul className="space-y-1" data-area-coverage>{areas.map(area => <li key={area.id}><span className="font-medium text-gray-900">{area.label}</span>{COVERAGE[`${id}:${area.id}`] && <span className="block">{COVERAGE[`${id}:${area.id}`]}</span>}<span className="block">{area.folders.some(folder => INTUNE_TYPES.some(type => type.folder === folder)) ? "Backups are available for the supported types in this area." : "This version has no backup types for this area yet."}</span><span className="block">{counts(area.permissions)} permissions</span></li>)}</ul>
              <p>{id === "defender" ? "Only policies exposed by Microsoft Graph are covered. Defender policies outside Graph and security event data are not included." : id === "entra" ? "Global Secure Access, passwords, secrets and user authentication methods are not included." : "Backs up policies, scripts and settings. App installers have a separate App Backup page."}</p>
              {id === "entra" && <label data-no-select className="flex items-start gap-2"><input type="checkbox" role="switch" aria-label="Include Conditional Access" checked={Boolean(choice.conditionalAccess)} onChange={event => toggle("conditionalAccess", event.target.checked)} className="mt-0.5 accent-primary" /><span>Conditional Access: policies, named locations and authentication strengths. Backups are available now.</span></label>}
              {module.areas.filter(area => area.optIn).map(area => <div key={area.id} className="space-y-1 border-t border-border pt-2">
                <label data-no-select className="flex items-center gap-2"><input type="checkbox" role="switch" aria-label={`Include ${area.label}`} disabled={!picked} checked={picked?.areas?.includes(area.id) ?? false} onChange={event => onChange({ ...choice, [id]: { ...picked!, areas: event.target.checked ? [...(picked?.areas ?? []), area.id] : picked?.areas?.filter(value => value !== area.id) } })} className="accent-primary" />{area.label} (opt-in)</label>
                <p>{area.folders.some(folder => INTUNE_TYPES.some(type => type.folder === folder)) ? "Backups are available for the supported types in this area." : "This version has no backup types for this area yet."}</p>
                {area.personalData && <p>{PERSONAL_DATA[area.id]}</p>}
              </div>)}
              {id === "intune" && <p>Includes the read access to Conditional Access from earlier Intune setups. Its backups stay off unless you turn them on inside Entra ID.</p>}
              <p>Every call runs as the admin who signs in, limited by their roles, MFA and Conditional Access.</p>
            </div>
          </details>
        </section>
      })}
    </div>
    <div className="flex justify-end"><Button disabled={!Object.keys(choice).length} onClick={onContinue}>Continue with {choiceLabel(choice)}</Button></div>
    <details className="rounded-2xl border border-border p-4" data-exact-permissions>
      <summary className="cursor-pointer text-sm font-medium text-gray-900">Show the exact permissions</summary>
      <div className="mt-3 space-y-4 text-sm text-gray-600">
        <p>Delegated Microsoft Graph permissions, grouped by area. Shared permissions can appear in more than one area and are requested once.</p>
        <div><h3 className="font-medium text-gray-900">Profile and organization</h3><ul>{BASE_PERMISSIONS.map(name => <li key={name} className="break-words">Read: {name}</li>)}</ul></div>
        {REQUEST_ORDER.flatMap(id => permissionsChoice[id] ? permissionAreas(id, permissionsChoice[id]!).map(area => <div key={`${id}:${area.id}`} data-permission-area>
          <h3 className="font-medium text-gray-900">{MODULE_BY_ID.get(id)!.label}: {area.label}</h3>
          <ul>{area.permissions.map(name => <li key={name} className="break-words">{isWrite(name) ? "Write" : "Read"}: {name}</li>)}</ul>
        </div>) : [])}
      </div>
    </details>
    <details className="rounded-2xl border border-border p-4" data-customize-access>
      <summary className="cursor-pointer text-sm font-medium text-gray-900">Customize access</summary>
      <div className="mt-3 space-y-3 text-sm text-gray-600">
        <p>Backup and restore asks for write permissions only where this version can restore. This choice grants nothing and does not block a restore your sign-in allows.</p>
        {Object.keys(choice).map(key => {
          const id = key as ModuleId
          const module = MODULE_BY_ID.get(id)!
          return <label key={id} className="flex flex-wrap items-center gap-3">{module.label}
            {canRequestRestore(id) ? <select aria-label={`${module.label} access`} className="rounded-lg border border-border bg-card p-2 text-foreground" value={choice[id]!.access} onChange={event => onChange({ ...choice, [id]: { ...choice[id]!, access: event.target.value as "backup" | "restore" } })}><option value="backup">Backup only</option><option value="restore">Backup and restore</option></select> : <span>Backup only. Restore is not available yet.</span>}
          </label>
        })}
      </div>
    </details>
    <p className="text-xs text-gray-600">All choices also read your own profile and organization details. Azure permissions list storage accounts and read and write backup files only if you choose Azure storage.</p>
  </div>
}
