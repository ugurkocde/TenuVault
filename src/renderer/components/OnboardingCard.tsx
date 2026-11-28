import type { ReactNode } from "react"
import { cn } from "~/lib/utils"

export const onboardingCard = "@container w-full rounded-3xl bg-card p-6 shadow-[0_24px_60px_-30px_rgba(22,21,20,0.25)] sm:p-10"
export const onboardingPrimary = "h-12 w-full whitespace-normal bg-blue-600 px-5 text-base text-white hover:bg-blue-700 sm:w-auto sm:min-w-60"
export const onboardingLink = "rounded-sm text-sm text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:opacity-50"

export function OnboardingHeading({ id, title, subtitle, icon, success = false }: {
  id: string
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  success?: boolean
}) {
  return (
    <div className="space-y-2 text-center">
      {icon && <span aria-hidden="true" className={cn("mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-secondary text-foreground [&>svg]:size-6", success && "text-green-700 dark:text-green-400")}>{icon}</span>}
      <h2 id={id} tabIndex={-1} className="mx-auto max-w-xl text-balance text-2xl font-medium tracking-tight text-foreground outline-none sm:text-3xl">{title}</h2>
      {subtitle && <p className="mx-auto max-w-[58ch] text-pretty text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  )
}
