import { Link } from 'react-router-dom'
import { useSelectedTenant } from '~/contexts/TenantContext'
import { tenantLicense, tenantPlan, useLicense } from '../lib/license'
import { NoticeCard, noticeActionClass } from './NoticeCard'
import { settingsHref } from '../lib/settings-section'

/** Explain prerequisites without hiding stored backups or audit history. */
export function TenantAccessNotice() {
  const { selectedTenant } = useSelectedTenant()
  const { status } = useLicense()
  if (!selectedTenant || !status) return null
  const license = tenantLicense(status, selectedTenant.credentials?.tenantId)
  if (license?.signedIn && tenantPlan(license)) return null
  return <NoticeCard className="mx-6 mt-5 lg:mx-8"
    summary={!license?.signedIn ? "Sign in to back up or restore this tenant." : "Backup and restore need an active license."}
    action={<Link className={noticeActionClass} to={!license?.signedIn ? settingsHref("signin") : "/license"}>
      {!license?.signedIn ? "Open sign-in settings" : "Open license"}
    </Link>} />
}
