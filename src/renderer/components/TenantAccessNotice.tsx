import { Link } from 'react-router-dom'
import { useSelectedTenant } from '~/contexts/TenantContext'
import { tenantLicense, tenantPlan, useLicense } from '../lib/license'
import { settingsHref } from '../lib/settings-section'

/** Explain prerequisites without hiding stored backups or audit history. */
export function TenantAccessNotice() {
  const { selectedTenant } = useSelectedTenant()
  const { status } = useLicense()
  if (!selectedTenant || !status) return null
  const license = tenantLicense(status, selectedTenant.credentials?.tenantId)
  if (license?.signedIn && tenantPlan(license)) return null
  return <aside role="status" className="mx-6 mt-5 rounded-3xl bg-amber-50 px-6 py-5 text-sm text-amber-900 lg:mx-8">
    <p><strong>{selectedTenant.name}</strong>: {!license?.signedIn ? 'Sign in to access Intune and verify this tenant’s license.' : 'An active license is required for backup and restore operations.'}</p>
    <div className="mt-3 flex flex-wrap gap-2"><Link className="rounded-full bg-primary px-4 py-2 font-medium text-primary-foreground transition-colors hover:bg-primary/90" to={settingsHref("signin")}>Open sign-in settings</Link><Link className="rounded-full bg-card px-4 py-2 font-medium text-amber-900 transition-colors hover:bg-amber-100" to="/license">Open license</Link></div>
  </aside>
}
