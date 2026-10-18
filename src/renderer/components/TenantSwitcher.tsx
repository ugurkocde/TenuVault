import { useNavigate } from "react-router-dom"
import { AlertTriangle, Building2, Check, ChevronsUpDown, LayoutGrid, Plus } from "lucide-react"
import { useSelectedTenant, useTenants } from "~/contexts/TenantContext"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { tenantLicense, useLicense } from "../lib/license"

/**
 * Picks the tenant every page works on, like the directory switcher in the Azure portal.
 * Tenants the license does not cover right now are marked.
 */
export function TenantSwitcher() {
  const tenants = useTenants()
  const { selectedTenant, setSelectedTenantId } = useSelectedTenant()
  const { status } = useLicense()
  const navigate = useNavigate()
  const unlicensed = (tenantId: string | undefined) => tenantLicense(status, tenantId)?.entitled === false

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
          aria-label={`Switch tenant. Current: ${selectedTenant?.name ?? "None"}, ${selectedTenant?.domain ?? ""}`}
          title={`${selectedTenant?.name ?? "Choose a tenant"} ${selectedTenant?.domain ?? ""}`}
        >
          <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-card text-foreground">
            <Building2 className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-gray-900">{selectedTenant?.name ?? "Choose a tenant"}</span>
            {unlicensed(selectedTenant?.credentials?.tenantId) ? (
              <span className="block truncate text-xs text-amber-700">Not licensed</span>
            ) : (
              <span className="block truncate text-xs text-gray-500">{selectedTenant?.domain || "Active tenant"}</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[14rem]" align="start">
        <DropdownMenuLabel>Tenants</DropdownMenuLabel>
        {tenants.map((tenant) => (
          <DropdownMenuItem key={tenant.id} onSelect={() => setSelectedTenantId(tenant.id)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{tenant.name}</span>
              {tenant.domain && <span className="block truncate text-xs text-gray-500">{tenant.domain}</span>}
            </span>
            {unlicensed(tenant.credentials?.tenantId) && (
              <AlertTriangle className="h-4 w-4 text-amber-600" aria-label="Not licensed" />
            )}
            {tenant.id === selectedTenant?.id && <Check className="h-4 w-4 text-blue-600" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {tenants.length > 1 && (
          <DropdownMenuItem onSelect={() => void navigate("/portal/overview")}>
            <LayoutGrid className="mr-2 h-4 w-4" /> All tenants
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void navigate("/portal/onboarding")}>
          <Plus className="mr-2 h-4 w-4" /> Connect a tenant
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
