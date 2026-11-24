import { Link } from "react-router-dom"
import { GRAPH_CLI_CLIENT_ID } from "../../shared/tenant-connection"
import { NoticeCard, noticeActionClass } from "./NoticeCard"
import { settingsHref } from "../lib/settings-section"

export function startNowTenantId(credentials?: { appId: string; tenantId: string }): string | null {
  return credentials?.appId?.toLowerCase() === GRAPH_CLI_CLIENT_ID ? credentials.tenantId.toLowerCase() : null
}

export function StartNowUpgradeLinks({ tenantId, message = "Start now provides read-only backups on this device." }: { tenantId: string; message?: string }) {
  const target = settingsHref("signin", `sign-in-${tenantId}`)
  return <NoticeCard summary={message} action={<Link className={noticeActionClass} to={target}>Review sign-in options</Link>} />
}
