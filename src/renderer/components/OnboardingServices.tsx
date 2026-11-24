import { ApplicationRestoreDisclosure } from "./ApplicationRestoreDisclosure"
import { INTUNE_TYPES } from "../../shared/intune/registry"
import { Button } from "~/components/ui/button"
import { MODULE_BY_ID, type ModuleId } from "../../shared/services/modules"
import { areaPermissions, BASE_PERMISSIONS, type PermissionChoice } from "../../shared/services/manifest"
import { BackupCoverage } from "./BackupCoverage"
import type { BackupScopeCoverage, SignInMethod } from "../../shared/tenant-connection"
import { canRequestRestore, choiceLabel, PERSONAL_DATA } from "../../shared/services/onboarding"

import { BACKUP_SERVICES, DISPLAY_MODULE_ORDER } from "../../shared/services/presentation"

const isWrite = (name: string) => /(?:^|\.)(?:ReadWrite|Write|Manage)(?:\.|$)/.test(name)
const counts = (permissions: readonly string[]) => `${permissions.filter(name => !isWrite(name)).length} read, ${permissions.filter(isWrite).length} write`

const DESCRIPTIONS = {
  intune: "Policies, apps, scripts, enrollment and tenant settings.",
  entra: "Tenant settings, sign-in policies, identity access and governance.",
  defender: "Detection rules, attack simulations, identity and posture configuration.",
}
const COVERAGE: Record<string, string> = {
  "entra:tenantSettings": "Tenant policies, branding and domains",
  "entra:authentication": "Sign-in policies and authentication settings",
  "entra:externalIdentities": "Guest access, identity providers and user flows",
  "entra:roles": "Custom roles, privileged access, administrative units and attribute definitions",
  "entra:governance": "Access packages, review definitions, lifecycle workflows and terms of use",
  "defender:detection": "Custom detection rules, security workbooks and case settings",
  "defender:email": "Attack simulation configuration and submission policies",
  "defender:identity": "Identity sensors and automatic auditing settings",
  "defender:posture": "Tenant Secure Score control states and security roles",
}

function permissionAreas(id: ModuleId, picked: NonNullable<PermissionChoice[ModuleId]>) {
  return MODULE_BY_ID.get(id)!.areas.filter(area => !area.optIn || picked.areas?.includes(area.id)).map(area => ({
    ...area, permissions: areaPermissions(area, picked.access, "delegated"),
  }))
}

export function OnboardingServices({ choice, onChange, onContinue, coverage, method }: { method: SignInMethod; coverage?: BackupScopeCoverage[]; choice: PermissionChoice; onChange: (choice: PermissionChoice) => void; onContinue: () => void }) {
  const toggle = (id: ModuleId, enabled: boolean) => {
    const next = { ...choice }
    if (enabled) next[id] = { access: "backup" }
    else {
      delete next[id]
      if (id === "entra") delete next.conditionalAccess
    }
    onChange(next)
  }
  const ownApp = method === "ownApp"
  const readOnly = method === "graphCli"
  return <div className="space-y-4">
    <div><h2 id="setup-step--1" tabIndex={-1} className="text-2xl font-medium tracking-tight text-gray-900 outline-none">What do you want to back up?</h2>
      <p className="mt-2 text-sm text-gray-600">Choose at least one service for this tenant.</p></div>
    {coverage && <div className="space-y-2"><p className="text-sm text-gray-600">Start now uses the backup permissions your sign-in already has. Restore is unavailable.</p><BackupCoverage coverage={coverage} /></div>}
    <div className="grid gap-3 @3xl:grid-cols-3">
      {BACKUP_SERVICES.map(({ id }) => {
        const module = MODULE_BY_ID.get(id)!
        const picked = choice[id]
        const areas = permissionAreas(id, picked ?? { access: "backup" })
        const permissions = [...new Set(areas.flatMap(area => area.permissions))]
        return <section key={id} data-onboarding-service={id} className={`min-w-0 rounded-2xl border p-4 ${picked ? "border-blue-300 bg-blue-50/60" : "border-border"}`}>
          <h3 className="font-medium text-gray-900">{module.label}</h3>
          <label data-no-select className="mt-3 flex items-center gap-2 text-sm text-gray-900">
            <input type="checkbox" aria-label={`Back up ${module.label}`} checked={Boolean(picked)} onChange={event => toggle(id, event.target.checked)} className="size-4 accent-primary" />Back up</label>
          <label data-no-select className="mt-2 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" aria-label={`Also restore ${module.label}`} checked={picked?.access === "restore"} disabled={!picked || readOnly || !canRequestRestore(id)} onChange={event => onChange({ ...choice, [id]: { ...picked, access: event.target.checked ? "restore" : "backup" } })} className="size-4 accent-primary" />Also restore
          </label>
          {id === "entra" && <label data-no-select className="mt-2 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" role="switch" aria-label="Include Conditional Access" disabled={!picked} checked={Boolean(choice.conditionalAccess)} onChange={event => toggle("conditionalAccess", event.target.checked)} className="size-4 accent-primary" />Conditional Access
          </label>}
          <p className="mt-3 text-sm text-gray-600">{DESCRIPTIONS[id]}</p>
          {ownApp && <p className="mt-3 text-xs font-medium text-gray-700" data-permission-count>{counts(permissions)} permissions{!picked && " if selected"}</p>}
          <details className="mt-3" data-choice-details hidden={readOnly}>
            <summary className="cursor-pointer text-sm font-medium text-blue-700">Coverage and permissions</summary>
            <div className="mt-3 max-h-40 space-y-3 overflow-y-auto overscroll-contain pr-1 text-xs text-gray-600" role="region" tabIndex={0} aria-label={`${module.label} coverage`}>
              {id === "defender" && <p>17 Microsoft Graph configuration types. Anti-phishing, Safe Links, Safe Attachments, anti-spam, anti-malware and quarantine policies, the Tenant Allow/Block List and Defender for Endpoint settings are not covered. Security events and campaign reports are excluded.</p>}
              <ul className="space-y-1" data-area-coverage>{areas.map(area => <li key={area.id}><span className="font-medium text-gray-900">{area.label}</span>{COVERAGE[`${id}:${area.id}`] && <span className="block">{COVERAGE[`${id}:${area.id}`]}</span>}<span className="block">{area.folders.some(folder => INTUNE_TYPES.some(type => type.folder === folder)) ? "Backups are available for the supported types in this area." : "This version has no backup types for this area yet."}</span>{id === "entra" && area.id === "governance" && <span className="block">Some features need Entra ID P2 or ID Governance. PDFs, review decisions and workflow history are excluded.</span>}{id === "entra" && area.id === "externalIdentities" && <span className="block">API connectors require the Backup Reader.</span>}{ownApp && <span className="block">{counts(area.permissions)} permissions</span>}</li>)}</ul>
              <p>{id === "defender" ? "People are stored by object ID only. Authored reporting mailbox addresses are kept as policy configuration." : id === "entra" ? "Global Secure Access, passwords, secrets and user authentication methods are not included." : "Backs up policies, scripts and settings. App installers have a separate App Backup page."}</p>
              {module.areas.filter(area => area.optIn).map(area => <div key={area.id} className="space-y-1 border-t border-border pt-2">
                <label data-no-select className="flex items-center gap-2"><input type="checkbox" role="switch" aria-label={`Include ${area.label}`} disabled={!picked || !area.folders.some(folder => INTUNE_TYPES.some(type => type.folder === folder))} checked={picked?.areas?.includes(area.id) ?? false} onChange={event => onChange({ ...choice, [id]: { ...picked!, areas: event.target.checked ? [...(picked?.areas ?? []), area.id] : picked?.areas?.filter(value => value !== area.id) } })} className="accent-primary" />{area.label} (opt-in)</label>
                <p>{area.folders.some(folder => INTUNE_TYPES.some(type => type.folder === folder)) ? "Backups are available for the supported types in this area." : "This version has no backup types for this area yet."}</p>
                {id === "entra" && area.id === "applications" && <ApplicationRestoreDisclosure />}
                {area.personalData && <p>{PERSONAL_DATA[area.id]}</p>}
              </div>)}
              <p>Every call runs as the admin who signs in, limited by their roles, MFA and Conditional Access.</p>
            </div>
          </details>
        </section>
      })}
    </div>
    <div className="flex justify-end"><Button disabled={!Object.keys(choice).length} onClick={onContinue}>Continue with {choiceLabel(choice)}</Button></div>
    <details hidden={!ownApp} className="rounded-2xl border border-border p-4" data-exact-permissions>
      <summary className="cursor-pointer text-sm font-medium text-gray-900">Show the exact permissions</summary>
      <div className="mt-3 space-y-4 text-sm text-gray-600">
        <p>Delegated Microsoft Graph permissions, grouped by area. Shared permissions can appear in more than one area and are requested once.</p>
        <div><h3 className="font-medium text-gray-900">Profile and organization</h3><ul>{BASE_PERMISSIONS.map(name => <li key={name} className="break-words">Read: {name}</li>)}</ul></div>
        {DISPLAY_MODULE_ORDER.flatMap(id => choice[id] ? permissionAreas(id, choice[id]!).map(area => <div key={`${id}:${area.id}`} data-permission-area>
          <h3 className="font-medium text-gray-900">{id === "conditionalAccess" ? "Entra ID: Conditional Access" : MODULE_BY_ID.get(id)!.label}: {area.label}</h3>
          <ul>{area.permissions.map(name => <li key={name} className="break-words">{isWrite(name) ? "Write" : "Read"}: {name}</li>)}</ul>
        </div>) : [])}
      </div>
    </details>
    <details hidden={readOnly} className="rounded-2xl border border-border p-4" data-customize-access>
      <summary className="cursor-pointer text-sm font-medium text-gray-900">Customize access</summary>
      <div className="mt-3 space-y-3 text-sm text-gray-600">
        <p>Backup and restore asks for write permissions only where this version can restore. This choice grants nothing and does not block a restore your sign-in allows.</p>
        {DISPLAY_MODULE_ORDER.filter(id => choice[id]).map(id => {
          const label = id === "conditionalAccess" ? "Entra ID: Conditional Access" : MODULE_BY_ID.get(id)!.label
          return <label key={id} className="flex flex-wrap items-center gap-3">{label}
            {canRequestRestore(id) ? <select aria-label={`${label} access`} className="rounded-lg border border-border bg-card p-2 text-foreground" value={choice[id]!.access} onChange={event => onChange({ ...choice, [id]: { ...choice[id]!, access: event.target.value as "backup" | "restore" } })}><option value="backup">Backup only</option><option value="restore">Backup and restore</option></select> : <span>Backup only. Restore is not available yet.</span>}
          </label>
        })}
      </div>
    </details>
    <p hidden={!ownApp} className="text-xs text-gray-600">All choices also read your own profile and organization details. Azure permissions list storage accounts and read and write backup files only if you choose Azure storage.</p>
  </div>
}
