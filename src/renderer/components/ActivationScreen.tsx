import { useLicense } from "../lib/license"
import { ArrowRight, DatabaseBackup, GitCompare, RotateCcw } from "lucide-react"
import { Button } from "~/components/ui/button"
import { BrandMark } from "./BrandMark"
import { TrialOrKey } from "./PlanChoice"

const POINTS = [
  { icon: DatabaseBackup, text: "Back up your Intune policies, encrypted on this computer." },
  { icon: RotateCcw, text: "Restore a single policy or a whole set when something breaks." },
  { icon: GitCompare, text: "See what changed between backups, down to the setting." },
]

/**
 * First run welcome, shown instead of the app while this machine has no license key, no
 * tenant licensed through its organization, no connected tenant and no setup in progress.
 *
 * Licensing is per tenant and enforced in the main process, so this screen is a guide, not a
 * lock: the plan is shown after the sign-in, when the tenant is known. Without a key the first
 * tenant runs on Community, and a license shared by the tenant's organization is picked up then.
 */
export function ActivationScreen({ onSignIn }: { onSignIn: () => void }) {
  const { status } = useLicense()
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-6 rounded-3xl bg-card p-9 shadow-[0_24px_60px_-30px_rgba(22,21,20,0.25)]">
        <div className="flex items-center gap-3">
          <BrandMark className="size-12" />
          <div>
            <h1 className="text-3xl font-medium tracking-tight text-gray-900">Welcome to TenuVault</h1>
            <p className="text-base text-gray-500">TenuVault Desktop</p>
          </div>
        </div>

        <ul className="space-y-3 text-sm text-gray-700">
          {POINTS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3">
              <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Icon className="h-4 w-4" /></span>
              {text}
            </li>
          ))}
        </ul>

        <div className="space-y-3">
          <Button size="lg" className="w-full bg-blue-600 text-white hover:bg-blue-700" onClick={onSignIn}>
            Connect your tenant <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
          <p className="text-xs text-gray-600">
            {status?.tenantTrialsEnabled
              ? "New tenants start with a Pro trial, no card and no email needed. Setup takes about 10 minutes: create an app registration, sign in and take a first backup. Afterwards, one tenant continues on Community Free."
              : "Setup takes about 10 minutes: create an app registration in your tenant, sign in and take a first backup. It is free on Community for one tenant, and a TenuVault license your organization shares with the tenant is picked up when you sign in."}
          </p>
        </div>

        <div className="border-t border-gray-100 pt-4">
          <TrialOrKey source="welcome" />
        </div>

        <p className="text-center text-xs text-gray-500">
          License checks go to tenuvault.com and send the license key or your Microsoft sign-in token, the tenant ID and a
          random installation ID. Tenant configuration and backups are never sent. Trials store a keyed hash of the tenant ID. An optional email is sent only when you submit it.
        </p>
      </div>
    </div>
  )
}
