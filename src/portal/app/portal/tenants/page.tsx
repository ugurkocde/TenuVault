"use client"

import { useBackupProgress } from "~/contexts/BackupProgressContext"
import { trackBackup } from "@desktop/lib/backups"
import { RunBackupDialog } from "@desktop/components/RunBackupDialog"
import { useState, useEffect, Suspense } from "react"
import { useSearchParams } from "next/navigation"
import {
  Search,
  Plus,
  MoreVertical,
  Database,
  Download,
  RefreshCw,
  Eye,
  Tag,
  MapPin,
  Globe,
  ChevronUp,
  ChevronDown,
  BarChart3,
  Grid3X3,
  List,
  Cloud,
  CloudUpload,
  Pencil,
  Check,
  X,
  Loader2,
  Rocket
} from "lucide-react"
import { cn } from "~/lib/utils"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu"
import { AddTenantModal, type TenantCredentials } from "~/components/tenants/add-tenant-modal-redesigned"
import { storageLabel } from "~/lib/storage-label"
import { BackupProgressModal } from "~/components/tenants/backup-progress-modal"
import { TagManagementModal } from "~/components/tenants/tag-management-modal"
import { useTenants, useTenantOperations, useTenantAzureSync, type Tenant } from "~/contexts/TenantContext"
import { useRouter } from "next/navigation"
import { useSchedules, formatWhen } from "@desktop/lib/schedules"
import { planName, tenantLicense, tenantPlan, useLicense } from "@desktop/lib/license"
import { GatedButton } from "@desktop/components/PlanGate"
import type { Plan } from "../../../../shared/plans"
import { Badge } from "~/components/ui/badge"


// Inner component that uses useSearchParams
function TenantsPageContent() {
  const router = useRouter()
  const schedules = useSchedules()
  const { status: licenseStatus } = useLicense()
  // Cross tenant views and bulk actions are part of MSP.
  // The highest plan among licensed tenants decides whether these buttons act or explain.
  const portfolioPlan: Plan | null = !licenseStatus ? null
    : licenseStatus.tenants.some((t) => t.entitled && t.plan === "msp") ? "msp"
    : licenseStatus.tenants.some((t) => t.entitled && t.plan === "pro") ? "pro" : "community"
  const [driftByTenant, setDriftByTenant] = useState<Record<string, { total: number; critical: number } | { error: string }>>({})
  const [checkingDrift, setCheckingDrift] = useState(false)
  const searchParams = useSearchParams()
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedTenants, setSelectedTenants] = useState<number[]>([])
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid")
  const [showAddTenantModal, setShowAddTenantModal] = useState(searchParams.get("connect") === "1")
  const [showTagModal, setShowTagModal] = useState(false)
  const [tagModalTenant, setTagModalTenant] = useState<Tenant | null>(null)

  // Use context hooks
  const tenants = useTenants()
  const { addJob } = useBackupProgress()
  const { addTenant, updateTenant, deleteTenant: deleteTenantFromContext, getTenant } = useTenantOperations()
  const { loadTenantFromAzure, checkTenantMetadata, deleteTenantMetadata, syncTenantToAzure, syncTenantToAzureDirect } = useTenantAzureSync()
  const [editingTenantId, setEditingTenantId] = useState<number | null>(null)
  const [editingTenantName, setEditingTenantName] = useState("")
  const [showProgressModal, setShowProgressModal] = useState(false)
  const [backupJobId, setBackupJobId] = useState<string | null>(null)
  const [backupTenant, setBackupTenant] = useState<Tenant | null>(null)
  const [syncingTenants, setSyncingTenants] = useState<Set<number>>(new Set())
  const [isBulkBackup, setIsBulkBackup] = useState(false)

  // Get all unique tags from tenants
  const allTenantTags = Array.from(
    new Set(tenants.flatMap(t => t.tags || []))
  ).sort()

  const filteredTenants = tenants.filter((tenant) => {
    const matchesSearch = tenant.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         tenant.domain.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesSearch
  })

  const toggleTenantSelection = (id: number) => {
    setSelectedTenants(prev =>
      prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]
    )
  }

  const startEditingTenant = (tenant: Tenant) => {
    setEditingTenantId(tenant.id)
    setEditingTenantName(tenant.name)
  }

  const saveTenantName = () => {
    if (editingTenantId && editingTenantName.trim()) {
      updateTenant(editingTenantId, { name: editingTenantName.trim() })

      // Show syncing status
      setSyncingTenants(prev => new Set(prev).add(editingTenantId))

      // Remove syncing status after a delay
      setTimeout(() => {
        setSyncingTenants(prev => {
          const newSet = new Set(prev)
          newSet.delete(editingTenantId)
          return newSet
        })
      }, 3000)
    }
    setEditingTenantId(null)
    setEditingTenantName("")
  }

  const cancelEditingTenant = () => {
    setEditingTenantId(null)
    setEditingTenantName("")
  }

  const deleteTenant = async (tenantId: number) => {
    const name = getTenant(tenantId)?.name ?? "this tenant"
    const shouldDelete = confirm(`Remove ${name} from TenuVault?\n\nThis signs you out of the tenant, stops its scheduled backups and frees its license slot. Existing backups are kept, and nothing in the tenant itself is changed.`)

    if (shouldDelete) {
      // The desktop tenant store releases the license, sign-in and schedule; backups are kept
      deleteTenantFromContext(tenantId)
    }
  }

  const openTagManagement = (tenant: Tenant) => {
    setTagModalTenant(tenant)
    setShowTagModal(true)
  }

  const handleTagsUpdate = async (tags: string[]) => {
    if (tagModalTenant) {
      // Update locally
      updateTenant(tagModalTenant.id, { tags })

      // Show syncing status
      setSyncingTenants(prev => new Set(prev).add(tagModalTenant.id))

      // Remove syncing status after a delay (sync happens automatically with debounce)
      setTimeout(() => {
        setSyncingTenants(prev => {
          const newSet = new Set(prev)
          newSet.delete(tagModalTenant.id)
          return newSet
        })
      }, 3000)
    }
  }

  const handleBulkTagUpdate = () => {
    if (selectedTenants.length === 0) return

    // For bulk operations, we'll use the first selected tenant as a template
    const firstSelectedTenant = tenants.find(t => t.id === selectedTenants[0])
    if (firstSelectedTenant) {
      setTagModalTenant({
        ...firstSelectedTenant,
        name: `${selectedTenants.length} tenants`,
        id: -1 // Special ID to indicate bulk operation
      } as Tenant)
      setShowTagModal(true)
    }
  }

  const handleBulkTagsSave = (tags: string[]) => {
    if (tagModalTenant?.id === -1) {
      // Bulk operation
      selectedTenants.forEach(tenantId => {
        updateTenant(tenantId, { tags })
      })
      setSelectedTenants([])
    } else {
      handleTagsUpdate(tags)
    }
  }

  const handleBulkBackup = async () => {
    if (selectedTenants.length === 0) return

    const selectedTenantObjects = tenants.filter(t => selectedTenants.includes(t.id))

    // Confirm with user
    const shouldBackup = confirm(`Are you sure you want to trigger a backup for ${selectedTenants.length} tenant${selectedTenants.length > 1 ? 's' : ''}?`)

    if (!shouldBackup) return

    // Set bulk backup flag to prevent modal from showing
    setIsBulkBackup(true)

    // Track which tenants are being backed up
    const backupPromises: Promise<void>[] = []

    for (const tenant of selectedTenantObjects) {
      // Skip if tenant doesn't have credentials or resources
      if (!tenant.credentials || !tenant.resources) {
        console.warn(`Skipping tenant ${tenant.name}: missing credentials or resources`)
        continue
      }

      // Create a promise for each backup operation
      const backupPromise = triggerBackup(tenant).catch(error => {
        console.error(`Failed to backup tenant ${tenant.name}:`, error)
      })

      backupPromises.push(backupPromise)

      // Add small delay between requests to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    // Wait for all backups to be initiated
    await Promise.allSettled(backupPromises)

    // Clear selection and reset bulk backup flag
    setSelectedTenants([])
    setIsBulkBackup(false)
  }

  // Compares each tenant's two newest complete backups, one tenant at a time.
  const checkAllDrift = async () => {
    setCheckingDrift(true)
    for (const tenant of tenants) {
      const tenantId = tenant.credentials?.tenantId?.toLowerCase()
      if (!tenantId || !tenant.resources?.storageAccountName) continue
      try {
        const response = await fetch("/api/detect-drifts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...tenant.credentials, storageAccountName: tenant.resources.storageAccountName }),
        })
        const data = await response.json()
        setDriftByTenant((current) => ({
          ...current,
          [tenantId]: response.ok ? { total: data.summary?.total ?? 0, critical: data.summary?.critical ?? 0 } : { error: data.error ?? "Drift check failed" },
        }))
      } catch (error) {
        setDriftByTenant((current) => ({ ...current, [tenantId]: { error: error instanceof Error ? error.message : "Drift check failed" } }))
      }
    }
    setCheckingDrift(false)
  }

  const triggerBackup = async (tenant: Tenant): Promise<void> => {
    if (!tenant.credentials || !tenant.resources?.storageAccountName) {

      return Promise.reject(new Error("Backup storage is not configured"))
    }

    updateTenant(tenant.id, { syncStatus: "pending" })
    try {
      const response = await fetch("/api/backup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: tenant.credentials.tenantId,
          appId: tenant.credentials.appId,
          clientSecret: tenant.credentials.clientSecret,
          storageAccountName: tenant.resources.storageAccountName,
        }),
      })
      const data = await response.json()
      if (!response.ok || typeof data.jobId !== "string" || !data.jobId) throw new Error(data.error || "Failed to start the backup")

      trackBackup(tenant, data.jobId, addJob)
    } catch (error) {
      console.error("Error starting backup:", error)
      updateTenant(tenant.id, { syncStatus: "error" })
      throw error
    }
  }

  // A single tenant's backup asks what to back up; bulk backups use each tenant's saved choice.
  const [scopeTenant, setScopeTenant] = useState<Tenant | null>(null)
  const chooseBackup = (tenant: Tenant) => {
    if (!tenant.credentials || !tenant.resources?.storageAccountName) {
      alert("Choose where backups for this tenant are stored in Settings first.")
      return
    }
    setScopeTenant(tenant)
  }
  const backupStarted = (tenant: Tenant, jobId: string) => {
    updateTenant(tenant.id, { syncStatus: "pending" })
    trackBackup(tenant, jobId, addJob)
    setBackupJobId(jobId)
    setBackupTenant(tenant)
    setShowProgressModal(true)
  }

  /** Creates the profile for a tenant the admin just connected (signed in, storage chosen). */
  const handleTenantAdded = async (credentials: TenantCredentials) => {
    setShowAddTenantModal(false)
    const resourceLocation = credentials.resourceGroupLocation ?? ""
      const newTenant: Tenant = {
      id: Date.now(),
      name: credentials.displayName || "New tenant",
      domain: "",
      status: "healthy",
      lastBackup: "",
      configCount: 0,
      storageUsed: "",
      client: "",
      license: "",
      region: resourceLocation ? formatAzureRegion(resourceLocation) : "",
      tags: [],
      users: 0,
      devices: 0,
      complianceRate: 0,
      industry: "",
      environment: "",
      lastSync: new Date().toISOString(),
      syncStatus: "idle",
      policies: {
        compliance: 0,
        configuration: 0,
        apps: 0,
      },
      credentials: { tenantId: credentials.tenantId, appId: credentials.appId, clientSecret: credentials.clientSecret },
      resources: {
        subscriptionId: credentials.subscriptionId ?? "",
        subscriptionName: "",
        resourceGroupName: credentials.resourceGroupName ?? "",
        storageAccountName: credentials.storageAccountName ?? "",
        automationAccountName: "",
        resourceGroupLocation: resourceLocation,
      },
      isLoading: true,
    }

    // Add to tenants list
    addTenant(newTenant)

    // Try to load metadata from Azure if it exists
    let finalName = credentials.displayName || "New Tenant"
    try {
      const metadata = await loadTenantFromAzure(credentials, credentials.storageAccountName ?? "")
      if (metadata) {
        console.log("Found existing metadata, updating tenant with restored data...")
        // Prioritize custom name from metadata
        finalName = metadata.customName || credentials.displayName || "New Tenant"
        updateTenant(newTenant.id, {
          name: finalName,
          domain: metadata.domain || newTenant.domain,
          tags: metadata.tags || newTenant.tags,
          environment: metadata.environment || newTenant.environment,
          license: metadata.license || newTenant.license,
          industry: metadata.industry || newTenant.industry,
          preferredRunbook: metadata.preferences?.preferredRunbook,
          region: metadata.azureResources?.resourceGroupLocation
            ? formatAzureRegion(metadata.azureResources.resourceGroupLocation)
            : newTenant.region,
          resources: metadata.azureResources?.resourceGroupLocation && newTenant.resources ? {
            ...newTenant.resources,
            resourceGroupLocation: metadata.azureResources.resourceGroupLocation
          } : newTenant.resources
        })
      } else {
        // No metadata found, use displayName from credentials
        updateTenant(newTenant.id, {
          name: finalName
        })
      }
    } catch (error) {
      console.error("Error loading metadata:", error)
      // On error, use displayName from credentials
      updateTenant(newTenant.id, {
        name: finalName
      })
    }

    // Fetch fresh data from Microsoft Graph
    // Create an updated tenant object with the final name
    const tenantWithCorrectName = {
      ...newTenant,
      name: finalName
    }
    setTimeout(() => {
      refreshTenantData(tenantWithCorrectName)
    }, 500)

    // Save metadata to Azure Storage with the correct name
    console.log("Saving tenant metadata to Azure Storage...")
    void syncTenantToAzureDirect(tenantWithCorrectName).then(() => {
      console.log("✅ Metadata saved to Azure Storage")
    }).catch((error) => {
      console.error("Failed to save metadata:", error)
    })

  }

  const refreshTenantData = async (tenant: Tenant) => {
    if (!tenant.credentials) {
      console.error("No credentials available for tenant")
      return
    }

    // Set loading state
    updateTenant(tenant.id, { isLoading: true })

    try {
      const response = await fetch("/api/fetch-tenant-details", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: tenant.credentials.tenantId,
          appId: tenant.credentials.appId,
          clientSecret: tenant.credentials.clientSecret,
        }),
      })

      if (response.ok) {
        const details = await response.json()

        // Update tenant with fresh data
        const currentName = tenant.name
        updateTenant(tenant.id, {
          name: currentName === "Loading..." || currentName === "New Tenant"
            ? details.organization.displayName
            : currentName, // Keep custom name if user renamed it
          domain: details.organization.primaryDomain,
          organizationId: details.organization.id,
          users: details.statistics.userCount,
          devices: details.statistics.deviceCount,
          complianceRate: details.statistics.complianceRate,
          configCount: details.statistics.policies.total,
          storageUsed: details.storageUsed,
          policies: {
            compliance: details.statistics.policies.compliancePolicies,
            configuration: details.statistics.policies.deviceConfigurations + details.statistics.policies.configurationPolicies,
            apps: details.statistics.policies.appProtectionPolicies,
            deviceConfigurations: details.statistics.policies.deviceConfigurations,
            configurationPolicies: details.statistics.policies.configurationPolicies,
            appProtectionPolicies: details.statistics.policies.appProtectionPolicies,
          },
          lastSync: new Date().toISOString(),
          syncStatus: "success",
          isLoading: false
        })
      } else {
        throw new Error("Failed to fetch tenant details")
      }
    } catch (error) {
      console.error("Error refreshing tenant data:", error)
      // Update tenant to show error state
      updateTenant(tenant.id, {
        isLoading: false,
        syncStatus: "error"
      })
    }
  }

  const getRelativeTime = (dateString: string) => {
    const date = new Date(dateString)
    if (!dateString || !Number.isFinite(date.getTime())) return "Never"
    const now = new Date()
    const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60))

    if (diffInHours < 1) return "Just now"
    if (diffInHours < 24) return `${diffInHours}h ago`
    if (diffInHours < 48) return "Yesterday"
    return `${Math.floor(diffInHours / 24)}d ago`
  }

  const getTagColor = (tag: string): any => {
    const tagColorMap: Record<string, string> = {
      Production: "green",
      Development: "yellow",
      Testing: "orange",
      Staging: "blue",
      Critical: "destructive",
      Priority: "purple",
      Pilot: "pink",
      Legacy: "gray",
      Migration: "blue",
      Compliance: "purple",
      GDPR: "purple",
      HIPAA: "purple",
      SOC2: "purple",
      ISO27001: "purple",
    }
    return (tagColorMap[tag] || "gray") as any
  }

  const getTagBadgeColor = (tag: string) => {
    const colorMap: Record<string, string> = {
      Production: "bg-green-100 text-green-700 border-green-200",
      Development: "bg-yellow-100 text-yellow-700 border-yellow-200",
      Testing: "bg-orange-100 text-orange-700 border-orange-200",
      Staging: "bg-blue-100 text-blue-700 border-blue-200",
      Critical: "bg-red-100 text-red-700 border-red-200",
      Priority: "bg-purple-100 text-purple-700 border-purple-200",
      Pilot: "bg-pink-100 text-pink-700 border-pink-200",
      Legacy: "bg-gray-100 text-gray-700 border-gray-200",
      Migration: "bg-blue-100 text-blue-700 border-blue-200",
      Compliance: "bg-purple-100 text-purple-700 border-purple-200",
      GDPR: "bg-purple-100 text-purple-700 border-purple-200",
      HIPAA: "bg-purple-100 text-purple-700 border-purple-200",
      SOC2: "bg-purple-100 text-purple-700 border-purple-200",
      ISO27001: "bg-purple-100 text-purple-700 border-purple-200",
    }
    return colorMap[tag] || "bg-gray-100 text-gray-700 border-gray-200"
  }

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }


  const formatAzureRegion = (region: string) => {
    // Format Azure region names to be more readable
    const regionMap: Record<string, string> = {
      "westeurope": "EU West",
      "northeurope": "EU North",
      "eastus": "US East",
      "eastus2": "US East 2",
      "westus": "US West",
      "westus2": "US West 2",
      "centralus": "US Central",
      "uksouth": "UK South",
      "ukwest": "UK West",
      "australiaeast": "Australia East",
      "southeastasia": "Southeast Asia",
      "eastasia": "East Asia",
      "japaneast": "Japan East",
      "japanwest": "Japan West",
      "canadacentral": "Canada Central",
      "canadaeast": "Canada East",
      "germanywestcentral": "Germany West",
      "francecentral": "France Central",
      "norwayeast": "Norway East",
      "switzerlandnorth": "Switzerland North",
      "brazilsouth": "Brazil South",
      "southafricanorth": "South Africa North",
      "uaenorth": "UAE North",
      "centralindia": "India Central",
      "koreacentral": "Korea Central"
    }
    return regionMap[region.toLowerCase()] || region
  }

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-medium tracking-tight text-gray-900">Tenant Management</h1>
          <p className="mt-2 text-base text-gray-500">Manage and monitor all your Intune tenants</p>
        </div>
        <div className="flex gap-3">
          <Button
            size="lg"
            className="bg-coral-600 text-white hover:bg-coral-700"
            onClick={() => setShowAddTenantModal(true)}
          >
            <Plus className="h-4 w-4" />
            Connect tenant
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            aria-label="Search tenants" placeholder="Search by name or domain..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-11 w-full rounded-full border border-gray-200 bg-white pl-11 pr-4 text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
        <div className="flex items-center gap-1 self-start rounded-full bg-white p-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Grid view" aria-pressed={viewMode === "grid"}
            onClick={() => setViewMode("grid")}
            className={cn(
              "size-9",
              viewMode === "grid" ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground" : "text-gray-500"
            )}
          >
            <Grid3X3 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="List view" aria-pressed={viewMode === "list"}
            onClick={() => setViewMode("list")}
            className={cn(
              "size-9",
              viewMode === "list" ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground" : "text-gray-500"
            )}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Bulk Actions */}
      {selectedTenants.length > 0 && (
        <div className="rounded-3xl bg-blue-50 px-5 py-3 flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-blue-700">
            {selectedTenants.length} tenant{selectedTenants.length > 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2">
            <GatedButton
              feature="bulkActions"
              plan={portfolioPlan}
              size="sm"
              className="bg-coral-600 text-white hover:bg-coral-700"
              onClick={handleBulkBackup}
              disabled={isBulkBackup}
            >
              <Download className="h-4 w-4 mr-1" />
              Backup Selected
            </GatedButton>
            <Button
              size="sm"
              onClick={handleBulkTagUpdate}
            >
              <Tag className="h-4 w-4 mr-1" />
              Tag Selected
            </Button>
          </div>
        </div>
      )}

      {/* Tenant Grid/List View */}
      {filteredTenants.length === 0 ? (
        <div className="flex flex-col items-center rounded-3xl bg-white px-6 py-16 text-center">
          <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
            <Database className="h-7 w-7 text-gray-500" />
          </div>
          <h3 className="text-xl font-medium tracking-tight text-gray-900 mb-2">{tenants.length ? "No matching tenants" : "No tenants configured"}</h3>
          <p className="text-gray-500">{tenants.length ? "Try a different name or domain." : "Get started by connecting your first Intune tenant"}</p>
          {tenants.length > 0 && <Button className="mt-6" onClick={() => setSearchQuery("")}>Clear search</Button>}
        </div>
      ) : viewMode === "grid" ? (
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredTenants.map((tenant) => (
          <div
            key={tenant.id}
            className={cn(
              "group relative bg-white rounded-3xl border overflow-hidden transition-colors cursor-pointer",
              selectedTenants.includes(tenant.id)
                ? "border-blue-200"
                : "border-transparent hover:border-gray-200"
            )}
          >
            <label className="flex items-center gap-2 px-6 pt-5 text-xs text-gray-500">
              <input type="checkbox" checked={selectedTenants.includes(tenant.id)} onChange={() => toggleTenantSelection(tenant.id)} aria-label={`Select ${tenant.name}`} /> Select tenant
            </label>
            {/* Status dot */}
            <div title={tenant.status} className={cn(
              "absolute top-6 right-6 h-2 w-2 rounded-full",
              tenant.status === "healthy" && "bg-green-500",
              tenant.status === "warning" && "bg-amber-500",
              tenant.status === "critical" && "bg-red-500"
            )} />

            <div className="px-6 pb-6 pt-4">
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-start gap-4">
                  <div className="h-12 w-12 shrink-0 rounded-full flex items-center justify-center font-medium text-base bg-primary text-primary-foreground">
                    {getInitials(tenant.name)}
                  </div>
                  <div className="flex-1">
                    {editingTenantId === tenant.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingTenantName}
                          onChange={(e) => setEditingTenantName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveTenantName()
                            if (e.key === 'Escape') cancelEditingTenant()
                          }}
                          className="flex-1 px-3 py-1 text-lg font-medium border border-gray-300 rounded-full focus:outline-none focus:border-blue-500"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                        <Button aria-label={`Save tenant name: ${tenant.name}`}
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            saveTenantName()
                          }}
                          className="h-7 w-7 p-0"
                        >
                          <Check className="h-4 w-4 text-green-600" />
                        </Button>
                        <Button aria-label={`Cancel editing tenant name: ${tenant.name}`}
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            cancelEditingTenant()
                          }}
                          className="h-7 w-7 p-0"
                        >
                          <X className="h-4 w-4 text-red-600" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium tracking-tight text-gray-900 text-lg">
                          {tenant.isLoading ? (
                            <span className="flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading...
                            </span>
                          ) : (
                            <span className="flex items-center gap-2">
                              {tenant.name}
                              {syncingTenants.has(tenant.id) && (
                                <span title="Syncing to cloud...">
                                  <CloudUpload className="h-4 w-4 text-blue-600 animate-pulse" />
                                </span>
                              )}
                            </span>
                          )}
                        </h3>
                        <Button aria-label={`Rename tenant: ${tenant.name}`}
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            startEditingTenant(tenant)
                          }}
                          className="h-6 w-6 p-0 opacity-100 transition-opacity"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
                      <Globe className="h-3 w-3" />
                      <span>{tenant.isLoading ? "loading..." : tenant.domain}</span>
                    </div>
                    {tenant.region && (
                      <div className="flex items-center gap-2 mt-2">
                        <span className="px-2.5 py-0.5 text-xs font-medium rounded-full border bg-white text-gray-700 border-gray-200">
                          {formatAzureRegion(tenant.region)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label={`Tenant actions: ${tenant.name}`}
                      variant="outline"
                      size="icon"
                      className="size-9 text-gray-500 hover:text-gray-700"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        startEditingTenant(tenant)
                      }}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit Name
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        openTagManagement(tenant)
                      }}
                    >
                      <Tag className="mr-2 h-4 w-4" />
                      Manage Tags
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteTenant(tenant.id)
                      }}
                      className="text-red-600 focus:text-red-600"
                    >
                      <X className="mr-2 h-4 w-4" />
                      Delete Tenant
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Tags */}
              {tenant.tags && tenant.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {tenant.tags.slice(0, 3).map(tag => (
                    <Badge
                      key={tag}
                      variant={getTagColor(tag)}
                      className="text-xs"
                    >
                      {tag}
                    </Badge>
                  ))}
                  {tenant.tags.length > 3 && (
                    <Badge variant="outline" className="text-xs">
                      +{tenant.tags.length - 3}
                    </Badge>
                  )}
                </div>
              )}

              {/* Policy Breakdown */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="flex flex-col justify-between gap-1 rounded-2xl bg-gray-50 p-4">
                  <span className="block text-xs text-gray-500">Compliance Policies</span>
                  <span className="mt-1 block text-2xl font-medium tracking-tight text-gray-900">{tenant.policies.compliance}</span>
                </div>
                <div className="flex flex-col justify-between gap-1 rounded-2xl bg-gray-50 p-4">
                  <span className="block text-xs text-gray-500">Configuration Profiles</span>
                  <span className="mt-1 block text-2xl font-medium tracking-tight text-gray-900">{tenant.policies.configuration}</span>
                </div>
              </div>

              {/* Azure Resources (if available) */}
              {tenant.resources && (
                <div className="pt-1 mb-4">
                  <p className="text-xs font-medium text-gray-500 mb-2">Backup storage</p>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center gap-1">
                      <Database className="h-3 w-3 text-gray-400" />
                      <span className="text-gray-600 truncate">{storageLabel(tenant.resources.storageAccountName)}</span>
                    </div>
                    {tenant.resources.automationAccountName && (
                      <div className="flex items-center gap-1">
                        <Cloud className="h-3 w-3 text-gray-400" />
                        <span className="text-gray-600 truncate">{tenant.resources.automationAccountName}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Sync Status */}
              <div className="flex items-center justify-between rounded-2xl bg-gray-50 px-4 py-3 mb-4">
                <div className="flex items-center gap-2">
                  <RefreshCw className={cn(
                    "h-4 w-4",
                    tenant.isLoading ? "animate-spin text-blue-600" :
                    tenant.syncStatus === "success" ? "text-green-600" :
                    tenant.syncStatus === "error" ? "text-red-600" : "text-gray-600"
                  )} />
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {tenant.isLoading ? "Syncing..." : `Last sync ${getRelativeTime(tenant.lastSync)}`}
                    </p>
                    <p className="text-xs text-gray-500">
                      {tenant.isLoading ? "Fetching latest data..." : (() => { const schedule = schedules.find(s => s.tenantId === tenant.credentials?.tenantId.toLowerCase()); return schedule?.enabled ? `Next backup: ${formatWhen(schedule.nextRunAt)}` : "Automatic backups off" })()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {tenant.credentials && !tenant.isLoading && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        refreshTenantData(tenant)
                      }}
                      className="h-8 w-8 p-0 rounded-full"
                      title="Refresh data"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  )}
                  <div className={cn(
                    "h-2 w-2 rounded-full",
                    tenant.isLoading ? "bg-blue-500 animate-pulse" :
                    tenant.syncStatus === "success" ? "bg-green-500" :
                    tenant.syncStatus === "error" ? "bg-red-500" : "bg-gray-400"
                  )} />
                </div>
              </div>


              {/* Actions */}
              <div className="flex gap-2">
                <Button
                  className="w-full bg-coral-600 text-white hover:bg-coral-700"
                  onClick={(e) => {
                    e.stopPropagation()
                    chooseBackup(tenant)
                  }}
                  disabled={tenant.syncStatus === "pending" || tenant.isLoading}
                >
                  {tenant.syncStatus === "pending" ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      Starting Backup...
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4 mr-1" />
                      Backup Now
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      ) : (
        /* List View */
        <div className="rounded-3xl bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-gray-100">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300"
                      aria-label="Select all matching tenants" checked={selectedTenants.length === filteredTenants.length && filteredTenants.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedTenants(filteredTenants.map(t => t.id))
                        } else {
                          setSelectedTenants([])
                        }
                      }}
                    />
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Tenant
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Status
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Region
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Policies
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Tags
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Last Backup
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Plan
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    <span className="flex items-center gap-2">
                      Drift
                      <GatedButton
                        feature="crossTenant"
                        plan={portfolioPlan}
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => void checkAllDrift()}
                        disabled={checkingDrift}
                        title="Compare each tenant's two latest backups"
                      >
                        {checkingDrift ? <Loader2 className="h-3 w-3 animate-spin" /> : "Check all"}
                      </GatedButton>
                    </span>
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredTenants.map((tenant) => (
                  <tr
                    key={tenant.id}
                    className={cn(
                      "hover:bg-gray-50 transition-colors",
                      selectedTenants.includes(tenant.id) && "bg-blue-50"
                    )}
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300"
                        aria-label={`Select ${tenant.name}`} checked={selectedTenants.includes(tenant.id)}
                        onChange={() => toggleTenantSelection(tenant.id)}
                      />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="h-10 w-10 shrink-0 rounded-full flex items-center justify-center font-medium text-sm bg-primary text-primary-foreground">
                          {getInitials(tenant.name)}
                        </div>
                        <div className="ml-4">
                          <div className="flex items-center gap-2">
                            {editingTenantId === tenant.id ? (
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={editingTenantName}
                                  onChange={(e) => setEditingTenantName(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') saveTenantName()
                                    if (e.key === 'Escape') cancelEditingTenant()
                                  }}
                                  className="px-3 py-1 text-sm font-medium border border-gray-300 rounded-full focus:outline-none focus:border-blue-500"
                                  autoFocus
                                />
                                <Button aria-label={`Save tenant name: ${tenant.name}`}
                                  variant="ghost"
                                  size="sm"
                                  onClick={saveTenantName}
                                  className="h-6 w-6 p-0"
                                >
                                  <Check className="h-3 w-3 text-green-600" />
                                </Button>
                                <Button aria-label={`Cancel editing tenant name: ${tenant.name}`}
                                  variant="ghost"
                                  size="sm"
                                  onClick={cancelEditingTenant}
                                  className="h-6 w-6 p-0"
                                >
                                  <X className="h-3 w-3 text-red-600" />
                                </Button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                <div className="text-sm font-medium text-gray-900">
                                  {tenant.isLoading ? (
                                    <span className="flex items-center gap-2">
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Loading...
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-2">
                                      {tenant.name}
                                      {syncingTenants.has(tenant.id) && (
                                        <span title="Syncing to cloud...">
                                          <CloudUpload className="h-3 w-3 text-blue-600 animate-pulse" />
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </div>
                                <Button aria-label={`Rename tenant: ${tenant.name}`}
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => startEditingTenant(tenant)}
                                  className="h-5 w-5 p-0 opacity-100"
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                              </div>
                            )}
                          </div>
                          <div className="text-sm text-gray-500">{tenant.domain}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium capitalize",
                        tenant.status === "healthy" && "bg-green-50 text-green-700",
                        tenant.status === "warning" && "bg-amber-50 text-amber-800",
                        tenant.status === "critical" && "bg-red-50 text-red-700"
                      )}>
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          tenant.status === "healthy" && "bg-green-500",
                          tenant.status === "warning" && "bg-amber-500",
                          tenant.status === "critical" && "bg-red-500"
                        )} />
                        {tenant.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {tenant.region && (
                        <span className="px-2.5 py-0.5 text-xs font-medium rounded-full border bg-white text-gray-700 border-gray-200">
                          {formatAzureRegion(tenant.region)}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      <div className="flex items-center gap-4">
                        <span title="Compliance Policies">{tenant.policies.compliance}</span>
                        <span title="Configuration Profiles">{tenant.policies.configuration}</span>
                        <span title="App Protection">{tenant.policies.apps}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {tenant.tags?.slice(0, 2).map(tag => (
                          <span
                            key={tag}
                            className={cn(
                              "px-2 py-0.5 text-xs font-medium rounded-full border",
                              getTagBadgeColor(tag)
                            )}
                          >
                            {tag}
                          </span>
                        ))}
                        {tenant.tags && tenant.tags.length > 2 && (
                          <span className="px-2 py-0.5 text-xs font-medium rounded-full border bg-gray-100 text-gray-700 border-gray-200">
                            +{tenant.tags.length - 2}
                          </span>
                        )}
                        {(!tenant.tags || tenant.tags.length === 0) && (
                          <span className="text-xs text-gray-400">No tags</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <div className="flex items-center gap-1">
                        <RefreshCw className="h-4 w-4 text-gray-400" />
                        {getRelativeTime(tenant.lastBackup)}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                      {(() => {
                        const plan = tenantPlan(tenantLicense(licenseStatus, tenant.credentials?.tenantId))
                        return plan ? planName(plan) : <span className="text-gray-400">Not licensed</span>
                      })()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {(() => {
                        const drift = driftByTenant[tenant.credentials?.tenantId?.toLowerCase() ?? ""]
                        if (!drift) return <span className="text-gray-400">Not checked</span>
                        if ("error" in drift) return <span className="text-amber-700" title={drift.error}>Not available</span>
                        if (drift.total === 0) return <span className="text-green-700">No drift</span>
                        return <span className={drift.critical > 0 ? "text-red-700" : "text-amber-800"}>{drift.total} change{drift.total === 1 ? "" : "s"}{drift.critical > 0 ? `, ${drift.critical} critical` : ""}</span>
                      })()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center gap-2">
                        <Button
                          size="icon"
                          variant="outline"
                          className="size-9"
                          aria-label={`Back up ${tenant.name}`} onClick={() => chooseBackup(tenant)}
                          disabled={tenant.syncStatus === "pending" || tenant.isLoading}
                        >
                          {tenant.syncStatus === "pending" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button aria-label={`Tenant actions: ${tenant.name}`} variant="ghost" size="icon" className="size-9">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => startEditingTenant(tenant)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit Name
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openTagManagement(tenant)}>
                              <Tag className="mr-2 h-4 w-4" />
                              Manage Tags
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => refreshTenantData(tenant)}
                              disabled={!tenant.credentials || tenant.isLoading}
                            >
                              <RefreshCw className="mr-2 h-4 w-4" />
                              Refresh Data
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => deleteTenant(tenant.id)}
                              className="text-red-600 focus:text-red-600"
                            >
                              <X className="mr-2 h-4 w-4" />
                              Delete Tenant
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Connect tenant Modal */}
      <AddTenantModal
        open={showAddTenantModal}
        onOpenChange={setShowAddTenantModal}
        onTenantAdded={handleTenantAdded}
      />

      {/* Tag Management Modal */}
      {tagModalTenant && (
        <TagManagementModal
          open={showTagModal}
          onOpenChange={setShowTagModal}
          tenantName={tagModalTenant.name}
          currentTags={tagModalTenant.id === -1 ? [] : tagModalTenant.tags || []}
          availableTags={allTenantTags}
          onTagsUpdate={handleBulkTagsSave}
        />
      )}

      {/* Backup Progress Modal */}
      <RunBackupDialog
        open={scopeTenant !== null}
        onOpenChange={(next) => !next && setScopeTenant(null)}
        tenant={scopeTenant?.credentials && scopeTenant.resources?.storageAccountName ? { name: scopeTenant.name, credentials: scopeTenant.credentials, storageAccountName: scopeTenant.resources.storageAccountName } : null}
        onStarted={(jobId) => scopeTenant && backupStarted(scopeTenant, jobId)}
      />
      {backupTenant && (
        <BackupProgressModal
          open={showProgressModal}
          onOpenChange={setShowProgressModal}
          tenantName={backupTenant.name}
          jobId={backupJobId}
          credentials={backupTenant.credentials ? {
            tenantId: backupTenant.credentials.tenantId,
            appId: backupTenant.credentials.appId,
            clientSecret: backupTenant.credentials.clientSecret,
          } : null}
          resources={backupTenant.resources ? {
            subscriptionId: backupTenant.resources.subscriptionId,
            resourceGroupName: backupTenant.resources.resourceGroupName,
            automationAccountName: backupTenant.resources.automationAccountName,
          } : null}
        />
      )}
    </div>
  )
}

// Main component wrapped in Suspense
export default function TenantsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    }>
      <TenantsPageContent />
    </Suspense>
  )
}
