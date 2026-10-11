"use client"

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react"
import type { TenantCredentials } from "~/components/tenants/add-tenant-modal"
import type { TenantMetadata } from "~/types/tenant-metadata"
import { tenantStorage } from "~/lib/tenant-storage"
import { clearTenantSyncTimers, deserializeTenants, scheduleTenantSync, serializeTenants, type TenantSyncTimers } from "~/lib/tenant-state"

/** Where a tenant's backups are stored (and, for Azure storage, its location). */
export interface SelectedResources {
  subscriptionId: string
  subscriptionName: string
  resourceGroupName: string
  resourceGroupLocation?: string
  storageAccountName: string
  automationAccountName: string
}

interface Tenant {
  id: number
  createdAt?: string
  name: string
  domain: string
  status: string
  lastBackup: string
  configCount: number
  storageUsed: string
  client: string
  license: string
  region: string
  tags: string[]
  users: number
  devices: number
  complianceRate: number
  industry: string
  environment: string
  lastSync: string
  syncStatus: string
  policies: {
    compliance: number
    configuration: number
    apps: number
    deviceConfigurations?: number
    configurationPolicies?: number
    appProtectionPolicies?: number
  }
  credentials?: TenantCredentials
  resources?: SelectedResources
  organizationId?: string
  isLoading?: boolean
  preferredRunbook?: string
}

interface TenantContextType {
  tenants: Tenant[]
  selectedTenantId: number | null
  setSelectedTenantId: (id: number | null) => void
  addTenant: (tenant: Tenant) => void
  updateTenant: (id: number, updates: Partial<Tenant>) => void
  deleteTenant: (id: number) => void
  getTenant: (id: number) => Tenant | undefined
  syncTenantToAzure: (tenantId: number) => Promise<void>
  syncTenantToAzureDirect: (tenant: Tenant) => Promise<void>
  loadTenantFromAzure: (credentials: TenantCredentials, storageAccountName: string) => Promise<TenantMetadata | null>
  checkTenantMetadata: (credentials: TenantCredentials, storageAccountName: string) => Promise<boolean>
  deleteTenantMetadata: (tenantId: number) => Promise<void>
}

const TenantContext = createContext<TenantContextType | undefined>(undefined)

const STORAGE_KEY = "tenuvault_tenants"
const SELECTED_TENANT_KEY = "tenuvault_selected_tenant"

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const tenantsRef = useRef(tenants)
  const syncTimeoutsRef = useRef<TenantSyncTimers>(new Map())

  useEffect(() => {
    tenantsRef.current = tenants
  }, [tenants])

  useEffect(() => {
    const timers = syncTimeoutsRef.current
    return () => clearTenantSyncTimers(timers)
  }, [])

  // Load tenants from sessionStorage on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = tenantStorage.getItem(STORAGE_KEY)
        const selectedId = tenantStorage.getItem(SELECTED_TENANT_KEY)
        
        if (stored) {
          setTenants(deserializeTenants(stored))
        }
        
        if (selectedId) {
          setSelectedTenantId(Number(selectedId))
        }
      } catch (error) {
        console.error("Error loading tenants from sessionStorage:", error)
      }
      setIsLoaded(true)
    }
  }, [])

  // Save tenants to sessionStorage whenever they change
  useEffect(() => {
    if (isLoaded && typeof window !== "undefined") {
      try {
        tenantStorage.setItem(STORAGE_KEY, serializeTenants(tenants))
      } catch (error) {
        console.error("Error saving tenants to sessionStorage:", error)
      }
    }
  }, [tenants, isLoaded])

  // Save selected tenant ID
  useEffect(() => {
    if (isLoaded && typeof window !== "undefined") {
      if (selectedTenantId !== null) {
        tenantStorage.setItem(SELECTED_TENANT_KEY, selectedTenantId.toString())
      } else {
        tenantStorage.removeItem(SELECTED_TENANT_KEY)
      }
    }
  }, [selectedTenantId, isLoaded])

  const addTenant = useCallback((tenant: Tenant) => {
    setTenants(prev => [...prev, { createdAt: new Date().toISOString(), ...tenant }])
  }, [])

  const updateTenant = useCallback((id: number, updates: Partial<Tenant>) => {
    setTenants(prev => prev.map(tenant => 
      tenant.id === id ? { ...tenant, ...updates } : tenant
    ))
  }, [])

  const deleteTenant = useCallback((id: number) => {
    setTenants(prev => prev.filter(tenant => tenant.id !== id))
    if (selectedTenantId === id) {
      setSelectedTenantId(null)
    }
  }, [selectedTenantId])

  const getTenant = useCallback((id: number) => {
    return tenants.find(tenant => tenant.id === id)
  }, [tenants])

  // Azure Storage sync methods
  const syncTenantToAzure = useCallback(async (tenantId: number) => {
    const tenant = tenants.find(t => t.id === tenantId)
    if (!tenant?.credentials || !tenant?.resources?.storageAccountName) {
      console.warn("Cannot sync tenant without credentials and storage account")
      return
    }

    try {
      const metadata: Partial<TenantMetadata> = {
        tenantId: tenant.credentials.tenantId,
        organizationId: tenant.organizationId,
        customName: tenant.name,
        domain: tenant.domain,
        tags: tenant.tags || [],
        environment: tenant.environment,
        license: tenant.license,
        industry: tenant.industry,
        azureResources: tenant.resources ? {
          subscriptionId: tenant.resources.subscriptionId,
          resourceGroupName: tenant.resources.resourceGroupName,
          storageAccountName: tenant.resources.storageAccountName,
          automationAccountName: tenant.resources.automationAccountName,
          resourceGroupLocation: tenant.resources.resourceGroupLocation,
        } : undefined,
        preferences: {
          preferredRunbook: tenant.preferredRunbook,
        },
        metadata: {
          createdAt: tenant.createdAt ?? new Date().toISOString(),
          lastModified: new Date().toISOString(),
        }
      }

      const response = await fetch("/api/tenant-metadata/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: tenant.credentials.tenantId,
          appId: tenant.credentials.appId,
          clientSecret: tenant.credentials.clientSecret,
          storageAccountName: tenant.resources.storageAccountName,
          metadata
        })
      })

      if (!response.ok) {
        const errorData = await response.json() as { error?: string }
        console.error("Failed to sync tenant to Azure:", errorData)
        
        // If container doesn't exist, log but don't throw - this is not critical
        if (response.status === 404) {
          console.warn("Metadata container doesn't exist. Metadata will not be persisted to cloud.")
          return
        }
        
        throw new Error(errorData.error ?? "Failed to sync tenant to Azure")
      }

      console.log("Tenant synced to Azure successfully")
    } catch (error) {
      console.error("Error syncing tenant to Azure:", error)
    }
  }, [tenants])
  
  // Direct sync method that accepts tenant object instead of ID
  const syncTenantToAzureDirect = useCallback(async (tenant: Tenant) => {
    if (!tenant?.credentials || !tenant?.resources?.storageAccountName) {
      console.warn("Cannot sync tenant without credentials and storage account")
      return
    }

    console.log("Starting sync to Azure for tenant:", {
      id: tenant.id,
      name: tenant.name,
      tags: tenant.tags,
      storageAccount: tenant.resources.storageAccountName
    })

    try {
      const metadata: Partial<TenantMetadata> = {
        tenantId: tenant.credentials.tenantId,
        organizationId: tenant.organizationId,
        customName: tenant.name,
        domain: tenant.domain,
        tags: tenant.tags || [],
        environment: tenant.environment,
        license: tenant.license,
        industry: tenant.industry,
        azureResources: tenant.resources ? {
          subscriptionId: tenant.resources.subscriptionId,
          resourceGroupName: tenant.resources.resourceGroupName,
          storageAccountName: tenant.resources.storageAccountName,
          automationAccountName: tenant.resources.automationAccountName,
          resourceGroupLocation: tenant.resources.resourceGroupLocation,
        } : undefined,
        preferences: {
          preferredRunbook: tenant.preferredRunbook,
        },
        metadata: {
          createdAt: tenant.createdAt ?? new Date().toISOString(),
          lastModified: new Date().toISOString(),
        }
      }

      const response = await fetch("/api/tenant-metadata/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: tenant.credentials.tenantId,
          appId: tenant.credentials.appId,
          clientSecret: tenant.credentials.clientSecret,
          storageAccountName: tenant.resources.storageAccountName,
          metadata
        })
      })

      if (!response.ok) {
        const errorData = await response.json() as { error?: string }
        console.error("Failed to sync tenant to Azure:", errorData)
        
        // If container doesn't exist, log but don't throw - this is not critical
        if (response.status === 404) {
          console.warn("Metadata container doesn't exist. Metadata will not be persisted to cloud.")
          return
        }
        
        throw new Error(errorData.error ?? "Failed to sync tenant to Azure")
      }

      console.log("Tenant synced to Azure successfully")
    } catch (error) {
      console.error("Error syncing tenant to Azure:", error)
    }
  }, [])

  const loadTenantFromAzure = useCallback(async (
    credentials: TenantCredentials, 
    storageAccountName: string
  ): Promise<TenantMetadata | null> => {
    try {
      const response = await fetch("/api/tenant-metadata/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: credentials.tenantId,
          appId: credentials.appId,
          clientSecret: credentials.clientSecret,
          storageAccountName
        })
      })

      const data = await response.json() as { exists: boolean; metadata?: TenantMetadata }
      
      // Check if the response indicates metadata exists
      if (data.exists && data.metadata) {
        console.log("Metadata found in Azure:", data.metadata)
        return data.metadata
      } else {
        console.log("No metadata found in Azure for this tenant")
        return null
      }
    } catch (error) {
      console.error("Error loading tenant from Azure:", error)
      return null
    }
  }, [])

  const checkTenantMetadata = useCallback(async (
    credentials: TenantCredentials,
    storageAccountName: string
  ): Promise<boolean> => {
    try {
      const response = await fetch("/api/tenant-metadata/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: credentials.tenantId,
          appId: credentials.appId,
          clientSecret: credentials.clientSecret,
          storageAccountName
        })
      })

      if (!response.ok) {
        return false
      }

      const data = await response.json() as { exists: boolean }
      return data.exists
    } catch (error) {
      console.error("Error checking tenant metadata:", error)
      return false
    }
  }, [])

  const deleteTenantMetadata = useCallback(async (tenantId: number) => {
    const tenant = tenants.find(t => t.id === tenantId)
    if (!tenant?.credentials || !tenant?.resources?.storageAccountName) {
      return
    }

    try {
      await fetch("/api/tenant-metadata/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: tenant.credentials.tenantId,
          appId: tenant.credentials.appId,
          clientSecret: tenant.credentials.clientSecret,
          storageAccountName: tenant.resources.storageAccountName
        })
      })
    } catch (error) {
      console.error("Error deleting tenant metadata:", error)
    }
  }, [tenants])

  // Auto-sync to Azure when tenant is updated (with debouncing)
  const updateTenantWithSync = useCallback((id: number, updates: Partial<Tenant>) => {
    updateTenant(id, updates)
    scheduleTenantSync(syncTimeoutsRef.current, id, () => {
      const updatedTenant = tenantsRef.current.find(t => t.id === id)
      if (updatedTenant) {
        console.log("Auto-syncing tenant to Azure after update:", {
          id: updatedTenant.id,
          tags: updatedTenant.tags,
          name: updatedTenant.name
        })
        void syncTenantToAzureDirect(updatedTenant)
      }
    })
  }, [updateTenant, syncTenantToAzureDirect])

  return (
    <TenantContext.Provider value={{
      tenants,
      selectedTenantId,
      setSelectedTenantId,
      addTenant,
      updateTenant: updateTenantWithSync, // Use the sync version
      deleteTenant,
      getTenant,
      syncTenantToAzure,
      syncTenantToAzureDirect,
      loadTenantFromAzure,
      checkTenantMetadata,
      deleteTenantMetadata
    }}>
      {children}
    </TenantContext.Provider>
  )
}

// Custom hooks for using the context
export function useTenants() {
  const context = useContext(TenantContext)
  if (!context) {
    throw new Error("useTenants must be used within a TenantProvider")
  }
  return context.tenants
}

export function useSelectedTenant() {
  const context = useContext(TenantContext)
  if (!context) {
    throw new Error("useSelectedTenant must be used within a TenantProvider")
  }
  return {
    selectedTenantId: context.selectedTenantId,
    selectedTenant: context.selectedTenantId ? context.getTenant(context.selectedTenantId) : undefined,
    setSelectedTenantId: context.setSelectedTenantId
  }
}

export function useTenantOperations() {
  const context = useContext(TenantContext)
  if (!context) {
    throw new Error("useTenantOperations must be used within a TenantProvider")
  }
  return {
    addTenant: context.addTenant,
    updateTenant: context.updateTenant,
    deleteTenant: context.deleteTenant,
    getTenant: context.getTenant
  }
}

export function useTenantAzureSync() {
  const context = useContext(TenantContext)
  if (!context) {
    throw new Error("useTenantAzureSync must be used within a TenantProvider")
  }
  return {
    syncTenantToAzure: context.syncTenantToAzure,
    syncTenantToAzureDirect: context.syncTenantToAzureDirect,
    loadTenantFromAzure: context.loadTenantFromAzure,
    checkTenantMetadata: context.checkTenantMetadata,
    deleteTenantMetadata: context.deleteTenantMetadata
  }
}

// Export the Tenant type for use in other components
export type { Tenant }
