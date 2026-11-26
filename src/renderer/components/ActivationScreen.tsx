import { ArrowRight, DatabaseBackup, GitCompare, RotateCcw } from "lucide-react"
import { useEffect, useRef } from "react"
import { Button } from "~/components/ui/button"
import { onboardingCard, onboardingPrimary } from "./OnboardingCard"
import { BrandMark } from "./BrandMark"
import { TrialOrKey } from "./PlanChoice"
import { recordSetup, WhatTenuVaultSends } from "./SetupDiagnostics"

const POINTS = [
  { icon: DatabaseBackup, text: "Back up the Microsoft services you choose and keep your backups encrypted." },
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
export function ActivationScreen({ onSignIn, focusHeading }: { onSignIn: () => void; focusHeading?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusHeading) heading.current?.focus({ preventScroll: true })
  }, [focusHeading])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-3">
      <div className={`${onboardingCard} max-w-[640px] space-y-6 text-center`}>
        <div className="flex flex-col items-center gap-4">
          <BrandMark className="size-12" />
          <div>
            <h1 ref={heading} tabIndex={focusHeading ? -1 : undefined} className="text-3xl font-medium tracking-tight text-gray-900 outline-none">Welcome to TenuVault</h1>
          </div>
        </div>

        <ul className="mx-auto w-fit space-y-3 text-left text-sm text-gray-700">
          {POINTS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3">
              <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-secondary" aria-hidden="true"><Icon className="h-4 w-4" /></span>
              {text}
            </li>
          ))}
        </ul>

        <div className="space-y-3">
          <Button className={onboardingPrimary} onClick={() => { recordSetup({ name: "welcome_continue" }); onSignIn() }}>
            Connect your tenant <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="text-left">
          <TrialOrKey source="welcome" />
        </div>

        <WhatTenuVaultSends />
      </div>
    </div>
  )
}
