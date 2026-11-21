import { useNavigate } from "react-router-dom"
import { ArrowRight, Check, ChevronsUpDown, LayoutGrid, Plus } from "lucide-react"
import { cn } from "~/lib/utils"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { tenantLicense, tenantPlan, tenantPlanName, useLicense } from "../lib/license"

/** Up to two letters for a tenant's badge: the first letters of its first two words, or the first two letters of one word. */
export function tenantInitials(name: string | undefined): string {
  // NFC first, so a name typed with combining accents gives the same letters as its composed spelling.
  const words = (name ?? "").normalize("NFC").trim().split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean)
  if (words.length === 0) return "?"
  const letters = words.length > 1 ? [...words[0]!].slice(0, 1).concat([...words[1]!].slice(0, 1)) : [...words[0]!].slice(0, 2)
  // One character per letter even where the capital is longer (ß becomes SS), so the badge keeps two.
  return letters.map((letter) => [...letter.toUpperCase()][0]).join("")
}

/** A tenant's initials on a tinted square: coral while the license covers it, amber when it does not. */
function TenantBadge({ name, unlicensed, small }: { name: string | undefined; unlicensed: boolean; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex flex-shrink-0 items-center justify-center font-semibold tracking-normal",
        small ? "size-7 rounded-lg text-[11px]" : "size-9 rounded-xl text-xs",
        unlicensed ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700",
      )}
    >
      {tenantInitials(name)}
    </span>
  )
}

/**
 * Picks the tenant every page works on, like the directory switcher in the Azure portal.
 * Tenants the license does not cover right now are marked. The menu fades and scales in from the
 * switcher (`.tv-pop` in desktop.css) and ends in a row for connecting another tenant.
 */
export function TenantSwitcher() {
  const tenants = useTenants()
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const { status } = useLicense()
  const navigate = useNavigate()
  const unlicensed = (tenantId: string | undefined) => {
    const license = tenantLicense(status, tenantId)
    return license !== undefined && tenantPlan(license) === null
  }

  const currentLicense = tenantLicense(status, selectedTenant?.credentials?.tenantId)
  const trialLabel = currentLicense?.entitled && currentLicense.trial ? tenantPlanName(currentLicense) : ""
  // What the line under the name says, so a screen reader hears it too.
  const stateLabel = unlicensed(selectedTenant?.credentials?.tenantId) ? "Not licensed" : trialLabel

  if (tenants.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void navigate("/portal/onboarding")}
        className="flex w-full items-center gap-3 rounded-full bg-secondary py-1.5 pl-1.5 pr-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-card" aria-hidden="true"><Plus className="h-4 w-4" /></span> Connect a tenant
      </button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-full bg-secondary py-1.5 pl-1.5 pr-3 text-left transition-colors hover:bg-accent"
          aria-label={`Switch tenant. Current: ${selectedTenant?.name ?? "None"}, ${selectedTenant?.domain ?? ""}${stateLabel ? `, ${stateLabel}` : ""}`}
          title={`${selectedTenant?.name ?? "Choose a tenant"} ${selectedTenant?.domain ?? ""}${stateLabel ? `, ${stateLabel}` : ""}`}
        >
          <TenantBadge name={selectedTenant?.name} unlicensed={unlicensed(selectedTenant?.credentials?.tenantId)} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-gray-900">{selectedTenant?.name ?? "Choose a tenant"}</span>
            {unlicensed(selectedTenant?.credentials?.tenantId) ? (
              <span className="block truncate text-xs text-amber-800">Not licensed</span>
            ) : (
              <span className="block truncate text-xs text-muted-foreground">{trialLabel || selectedTenant?.domain || "Active tenant"}</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      {/* Capped to the room Radix finds below or above the switcher: the tenant list scrolls and Connect a tenant stays in view. */}
      <DropdownMenuContent className="tv-pop flex max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 flex-col overflow-hidden rounded-[1.375rem] p-0" align="start" sideOffset={6} collisionPadding={12}>
        <DropdownMenuLabel className="shrink-0 px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground">Tenants</DropdownMenuLabel>
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-1.5">
          {tenants.map((tenant) => {
            const notLicensed = unlicensed(tenant.credentials?.tenantId)
            const trial = tenantLicense(status, tenant.credentials?.tenantId)?.trial
            return (
              <DropdownMenuItem key={tenant.id} textValue={tenant.name} onSelect={() => setSelectedTenantId(tenant.id)} className="gap-3 rounded-2xl px-2 py-1.5">
                <TenantBadge name={tenant.name} unlicensed={notLicensed} small />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{tenant.name}</span>
                  {notLicensed
                    ? <span className="block truncate text-xs text-amber-800">Not licensed</span>
                    : tenant.domain && <span className="block truncate text-xs text-muted-foreground">{trial ? "Pro trial" : tenant.domain}</span>}
                </span>
                {tenant.id === selectedTenant?.id && <Check className="h-4 w-4 text-blue-600" aria-label="Selected" />}
              </DropdownMenuItem>
            )
          })}
          {tenants.length > 1 && (
            <>
              <DropdownMenuSeparator className="mx-2" />
              <DropdownMenuItem onSelect={() => void navigate("/portal/overview")} className="gap-3 rounded-2xl px-2 py-1.5">
                <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-lg bg-secondary"><LayoutGrid className="h-4 w-4" /></span> All tenants
              </DropdownMenuItem>
            </>
          )}
        </div>
        <div className="shrink-0 border-t bg-secondary/60 p-1.5">
          <DropdownMenuItem onSelect={() => void navigate("/portal/onboarding")} className="group/connect gap-3 rounded-2xl px-2 py-2">
            <span aria-hidden="true" className="flex size-8 flex-shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground"><Plus className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">Connect a tenant</span>
              <span className="block text-xs text-muted-foreground">Add another tenant with the guided setup</span>
            </span>
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground motion-safe:transition-transform motion-safe:group-focus/connect:translate-x-0.5" />
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
