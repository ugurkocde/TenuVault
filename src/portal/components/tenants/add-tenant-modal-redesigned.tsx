"use client"

import { useState } from "react"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Alert, AlertDescription } from "~/components/ui/alert"
import { 
  Loader2, AlertCircle, Shield, Upload, FileJson, Plus, 
  Zap, Clock, CheckCircle, Info, Eye, EyeOff,
  Settings, X
} from "lucide-react"
import { cn } from "~/lib/utils"

interface AddTenantModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onTenantAdded: (tenant: TenantCredentials) => void
}

export interface TenantCredentials {
  tenantId: string
  appId: string
  clientSecret: string
  displayName?: string
  storageAccountName?: string
  automationAccountName?: string
  resourceGroupName?: string
  subscriptionId?: string
  resourceGroupLocation?: string
  /** Resources were chosen and verified by the caller (desktop app): skip validation and the resource picker. */
  preconfigured?: boolean
  preferredRunbook?: string
}

export function AddTenantModal({ open, onOpenChange, onTenantAdded }: AddTenantModalProps) {
  const [tenantId, setTenantId] = useState("")
  const [appId, setAppId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [storageAccountName, setStorageAccountName] = useState("")
  const [automationAccountName, setAutomationAccountName] = useState("")
  const [resourceGroupName, setResourceGroupName] = useState("")
  const [subscriptionId, setSubscriptionId] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [importError, setImportError] = useState("")
  const [selectedMethod, setSelectedMethod] = useState<'json' | 'manual'>('json')
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [showSecret, setShowSecret] = useState(false)

  // Reset form when modal closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setTenantId("")
      setAppId("")
      setClientSecret("")
      setDisplayName("")
      setStorageAccountName("")
      setAutomationAccountName("")
      setResourceGroupName("")
      setSubscriptionId("")
      setError("")
      setImportError("")
      setIsSubmitting(false)
      setSelectedMethod('json')
      setUploadedFile(null)
      setShowSecret(false)
    }
    onOpenChange(newOpen)
  }

  const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    processFile(file)
  }

  const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragOver(false)
    
    const file = event.dataTransfer.files?.[0]
    if (file) {
      processFile(file)
    }
  }

  const processFile = async (file: File) => {
    setImportError("")
    setUploadedFile(file)
    
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      
      // Validate the JSON structure
      if (!data.tenantId || !data.appId || !data.clientSecret) {
        setImportError("Invalid JSON format. Required fields: tenantId, appId, clientSecret")
        setUploadedFile(null)
        return
      }
      
      // Populate form fields
      setTenantId(data.tenantId)
      setAppId(data.appId)
      setClientSecret(data.clientSecret)
      setDisplayName(data.displayName || data.name || "")
      setStorageAccountName(data.storageAccountName || "")
      setAutomationAccountName(data.automationAccountName || "")
      setResourceGroupName(data.resourceGroupName || "")
      setSubscriptionId(data.subscriptionId || "")
    } catch (err) {
      setImportError("Failed to parse JSON file. Please ensure it's a valid JSON format.")
      setUploadedFile(null)
      console.error("Import error:", err)
    }
  }

  const validateGuid = (value: string) => {
    const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    return guidRegex.test(value)
  }

  const handleSubmit = async () => {
    // Validate required fields
    if (!tenantId || !appId || !clientSecret) {
      setError("Please fill in all required fields")
      return
    }

    // Validate GUIDs
    if (!validateGuid(tenantId)) {
      setError("Invalid Tenant ID format")
      return
    }

    if (!validateGuid(appId)) {
      setError("Invalid Application ID format")
      return
    }

    setIsSubmitting(true)
    setError("")

    try {
      // Pass the credentials to the parent component
      onTenantAdded({
        tenantId,
        appId,
        clientSecret,
        displayName,
        storageAccountName,
        automationAccountName,
        resourceGroupName,
        subscriptionId
      })
      
      // The parent will close this modal and open the resource selection modal
    } catch {
      setError("Failed to add tenant. Please try again.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Tenant</DialogTitle>
          <DialogDescription>
            Connect your Microsoft Intune environment
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Method Selection Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* JSON Import - Primary Method */}
            <div 
              className={cn(
                "relative overflow-hidden rounded-3xl transition-all duration-200 cursor-pointer",
                selectedMethod === 'json' 
                  ? "bg-blue-50 ring-2 ring-coral-500" 
                  : "bg-gray-50 hover:bg-gray-100"
              )}
              onClick={() => setSelectedMethod('json')}
            >
              {/* Recommended Badge */}
              <div className="absolute top-3 right-3">
                <div className="bg-coral-600 text-white text-xs font-medium px-2.5 py-0.5 rounded-full">
                  Recommended
                </div>
              </div>
              
              <div className="p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-white flex items-center justify-center">
                    <FileJson className="h-6 w-6 text-blue-700" />
                  </div>
                  <div>
                    <h4 className="font-medium tracking-tight text-gray-900">Import from JSON</h4>
                    <p className="text-xs text-gray-500">Fastest setup</p>
                  </div>
                </div>
                
                <p className="text-sm text-gray-600 leading-relaxed">
                  Use the credentials file automatically downloaded after onboarding.
                </p>
                
                <div className="flex items-center gap-2 text-xs text-blue-700">
                  <Zap className="h-3 w-3" />
                  <span className="font-medium">Instant setup</span>
                </div>
              </div>
            </div>

            {/* Manual Entry - Secondary Method */}
            <div 
              className={cn(
                "relative rounded-3xl transition-all duration-200 cursor-pointer",
                selectedMethod === 'manual' 
                  ? "bg-blue-50 ring-2 ring-coral-500" 
                  : "bg-gray-50 hover:bg-gray-100"
              )}
              onClick={() => setSelectedMethod('manual')}
            >
              <div className="p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-white flex items-center justify-center">
                    <Settings className="h-6 w-6 text-gray-600" />
                  </div>
                  <div>
                    <h4 className="font-medium tracking-tight text-gray-900">Manual Entry</h4>
                    <p className="text-xs text-gray-500">Advanced setup</p>
                  </div>
                </div>
                
                <p className="text-sm text-gray-600 leading-relaxed">
                  Enter your Azure application credentials manually.
                </p>
                
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Clock className="h-3 w-3" />
                  <span>Manual configuration</span>
                </div>
              </div>
            </div>
          </div>

          {/* Dynamic Content Based on Selection */}
          <div className="min-h-[200px]">
            {selectedMethod === 'json' && (
              <div className="space-y-4">
                {/* File Drop Zone */}
                <div 
                  className={cn(
                    "relative border border-dashed rounded-3xl p-8 text-center transition-all duration-200",
                    isDragOver 
                      ? "border-coral-500 bg-blue-50" 
                      : "border-gray-300 hover:bg-gray-50"
                  )}
                  onDrop={handleFileDrop}
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                >
                  <input
                    id="json-import"
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileImport}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  
                  <div className="space-y-4">
                    <div className="mx-auto h-16 w-16 rounded-full bg-blue-50 flex items-center justify-center">
                      <Upload className="h-8 w-8 text-blue-700" />
                    </div>
                    
                    <div className="space-y-2">
                      <h4 className="font-medium tracking-tight text-gray-900">
                        Drop your credentials file here
                      </h4>
                      <p className="text-sm text-gray-500">
                        Or click to browse and select your JSON file
                      </p>
                    </div>
                    
                    <Button className="bg-coral-600 text-white hover:bg-coral-700">
                      <Upload className="mr-2 h-4 w-4" />
                      Choose File
                    </Button>
                  </div>
                </div>
                
                {/* Success State */}
                {uploadedFile && !importError && (
                  <div className="rounded-2xl bg-green-50 p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-white flex items-center justify-center">
                        <CheckCircle className="h-5 w-5 text-green-600" />
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-green-900">File uploaded successfully</p>
                        <p className="text-sm text-green-700">{uploadedFile.name}</p>
                      </div>
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => {
                          setUploadedFile(null)
                          setTenantId("")
                          setAppId("")
                          setClientSecret("")
                          setDisplayName("")
                        }}
                        className="rounded-full text-green-700 hover:bg-green-100"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
                
                {/* Error State */}
                {importError && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{importError}</AlertDescription>
                  </Alert>
                )}
                
                {/* Help Text */}
                <div className="rounded-2xl bg-blue-50 p-4">
                  <div className="flex items-start gap-3">
                    <Info className="h-5 w-5 text-blue-700 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-blue-900">Looking for your credentials file?</p>
                      <p className="text-sm text-blue-700">
                        This file was automatically downloaded after completing the onboarding wizard.                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {selectedMethod === 'manual' && (
              <div className="space-y-4">
                {/* Form Fields */}
                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="displayName" className="text-sm font-medium text-gray-700">
                      Display Name <span className="text-gray-400">(Optional)</span>
                    </Label>
                    <Input 
                      id="displayName" 
                      placeholder="e.g., Contoso Production"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="h-11"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="tenantId" className="text-sm font-medium text-gray-700">
                      Tenant ID <span className="text-red-600">*</span>
                    </Label>
                    <Input 
                      id="tenantId" 
                      placeholder="00000000-0000-0000-0000-000000000000"
                      value={tenantId}
                      onChange={(e) => setTenantId(e.target.value)}
                      className={cn(
                        "h-11 font-mono text-sm",
                        tenantId && !validateGuid(tenantId) && "border-destructive"
                      )}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="appId" className="text-sm font-medium text-gray-700">
                      Application ID <span className="text-red-600">*</span>
                    </Label>
                    <Input 
                      id="appId" 
                      placeholder="00000000-0000-0000-0000-000000000000"
                      value={appId}
                      onChange={(e) => setAppId(e.target.value)}
                      className={cn(
                        "h-11 font-mono text-sm",
                        appId && !validateGuid(appId) && "border-destructive"
                      )}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="clientSecret" className="text-sm font-medium text-gray-700">
                      Client Secret <span className="text-red-600">*</span>
                    </Label>
                    <div className="relative">
                      <Input 
                        id="clientSecret" 
                        type={showSecret ? "text" : "password"}
                        placeholder="Enter your client secret"
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        className="h-11 pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1 h-9 w-9 p-0"
                        onClick={() => setShowSecret(!showSecret)}
                      >
                        {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Error Display */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Security Notice */}
          <Alert className="rounded-2xl border-transparent bg-green-50">
            <Shield className="h-4 w-4 text-green-600" />
            <AlertDescription className="text-green-800">
              <span className="font-medium">Enterprise-grade security:</span> All credentials are encrypted 
              and stored securely. We never access or store your tenant data.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleSubmit}
            disabled={isSubmitting || (!tenantId || !appId || !clientSecret)}
            className="bg-coral-600 text-white hover:bg-coral-700"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Adding Tenant...
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Add Tenant
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}