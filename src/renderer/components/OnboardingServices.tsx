import { Button } from "~/components/ui/button"
import { MODULE_BY_ID, type ModuleId } from "../../shared/services/modules"
import { requestedPermissions, type PermissionChoice } from "../../shared/services/manifest"
import { canRequestRestore, choiceLabel, onboardingPermissions, PERSONAL_DATA } from "../../shared/services/onboarding"

export function OnboardingServices({ choice, onChange, onContinue }: { choice: PermissionChoice; onChange: (choice: PermissionChoice) => void; onContinue: () => void }) {
  const toggle = (id: ModuleId, enabled: boolean) => {
    const next = { ...choice }
    if (enabled) next[id] = { access: MODULE_BY_ID.get(id)!.defaultAccess }
    else delete next[id]
    onChange(next)
  }
  return <div className="space-y-5">
    <div><h2 id="setup-step--1" tabIndex={-1} className="text-2xl font-medium tracking-tight text-gray-900">What do you want to back up?</h2>
      <p className="mt-2 text-sm text-gray-600">Choose services for this tenant. Review permissions below, or keep the defaults and continue.</p></div>
    <div className="grid items-start gap-3 lg:grid-cols-3">
      {(["intune", "entra", "defender"] as const).map(id => {
        const module = MODULE_BY_ID.get(id)!
        const picked = choice[id]
        const permissions = requestedPermissions(onboardingPermissions({ [id]: picked ?? { access: module.defaultAccess } }), "delegated")[0]!.permissions
        return <section key={id} data-onboarding-service={id} className={`min-w-0 rounded-2xl border p-4 ${picked ? "border-blue-300 bg-blue-50/60" : "border-border"}`}>
          <label data-no-select className="flex items-center justify-between gap-3 font-medium text-gray-900">{module.label}
            <input type="checkbox" aria-label={`Back up ${module.label}`} checked={Boolean(picked)} onChange={event => toggle(id, event.target.checked)} className="size-4 accent-primary" /></label>
          <p className="mt-3 text-sm text-gray-600">{module.description}</p>
          {id !== "intune" && <p className="mt-3 text-sm font-medium text-gray-700">This version sets up {module.label} permissions. Backups arrive in a later update.</p>}
          <details className="mt-4" data-choice-details>
            <summary className="cursor-pointer text-sm font-medium text-blue-700">Coverage and permissions</summary>
            <div className="mt-3 space-y-3 text-xs text-gray-600">
              <p>{id === "defender" ? "Only policies exposed by Microsoft Graph are covered. Defender policies outside Graph and security event data are not included." : id === "entra" ? "Global Secure Access, passwords, secrets and user authentication methods are not included." : "Backs up policies, scripts and settings. App installers have a separate App Backup page."}</p>
              {id === "entra" && <label data-no-select className="flex items-start gap-2"><input type="checkbox" role="switch" aria-label="Include Conditional Access" checked={Boolean(choice.conditionalAccess)} onChange={event => toggle("conditionalAccess", event.target.checked)} className="mt-0.5 accent-primary" /><span>Conditional Access: policies, named locations and authentication strengths. Backups are available now.</span></label>}
              {id === "entra" && choice.conditionalAccess && <div className="space-y-1"><p className="font-medium text-gray-900">Conditional Access permissions</p><ul>{requestedPermissions({ conditionalAccess: choice.conditionalAccess }, "delegated")[0]!.permissions.map(name => <li key={name} className="break-words">{/(?:^|\.)(?:ReadWrite|Write|Manage)(?:\.|$)/.test(name) ? "Write" : "Read"}: {name}</li>)}</ul></div>}
              {module.areas.filter(area => area.optIn).map(area => <div key={area.id} className="space-y-1 border-t border-border pt-2">
                <label data-no-select className="flex items-center gap-2"><input type="checkbox" role="switch" aria-label={`Include ${area.label}`} disabled={!picked} checked={picked?.areas?.includes(area.id) ?? false} onChange={event => onChange({ ...choice, [id]: { ...picked!, areas: event.target.checked ? [...(picked?.areas ?? []), area.id] : picked?.areas?.filter(value => value !== area.id) } })} className="accent-primary" />{area.label} (opt-in)</label>
                {area.personalData && <p>{PERSONAL_DATA[area.id]}</p>}
              </div>)}
              {id === "intune" && <p>Includes the read access to Conditional Access from earlier Intune setups. Its backups stay off unless you turn them on inside Entra ID.</p>}
              <p className="font-medium text-gray-900">Delegated Microsoft Graph permissions</p>
              <ul className="space-y-1">{permissions.map(name => <li key={name} className="break-words"><span className="font-medium">{/(?:^|\.)(?:ReadWrite|Write|Manage)(?:\.|$)/.test(name) ? "Write" : "Read"}</span>: {name}</li>)}</ul>
              <p>Every call runs as the admin who signs in, limited by their roles, MFA and Conditional Access.</p>
            </div>
          </details>
        </section>
      })}
    </div>
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
    <div className="flex justify-end"><Button disabled={!Object.keys(choice).length} onClick={onContinue}>Continue with {choiceLabel(choice)}</Button></div>
  </div>
}
