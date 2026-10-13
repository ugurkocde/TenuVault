"use client"

import { useState } from "react"
import { 
  CheckCircle2, 
  XCircle, 
  Loader2,
  RefreshCw,
  FileDown,
  Database,
  Upload,
  GitBranch,
  AlertCircle
} from "lucide-react"
import { Button } from "~/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog"
import { cn } from "~/lib/utils"

interface RevertProgressModalProps {
  isOpen: boolean
  onClose: () => void
  action: "revert" | "restore"
  policyName: string
  currentStep?: number
  error?: string | null
  isComplete?: boolean
  isSuccess?: boolean
  onComplete?: (success: boolean) => void
  newPolicyId?: string
  policyType?: string
}

interface ProgressStep {
  id: string
  label: string
  status: "pending" | "active" | "completed" | "error"
  icon: React.ReactNode
}

export function RevertProgressModal({
  isOpen,
  onClose,
  action,
  policyName,
  currentStep = 0,
  error = null,
  isComplete = false,
  isSuccess = false,
  onComplete,
  newPolicyId,
  policyType
}: RevertProgressModalProps) {

  const steps: ProgressStep[] = [
    {
      id: "fetch",
      label: "Fetching policy from backup",
      status: "pending",
      icon: <FileDown className="h-5 w-5" />
    },
    {
      id: "prepare",
      label: "Preparing policy data",
      status: "pending",
      icon: <Database className="h-5 w-5" />
    },
    {
      id: "apply",
      label: action === "revert" ? "Applying changes to Intune" : "Creating new policy in Intune",
      status: "pending",
      icon: <Upload className="h-5 w-5" />
    },
    {
      id: "metadata",
      label: "Updating metadata",
      status: "pending",
      icon: <GitBranch className="h-5 w-5" />
    },
    {
      id: "refresh",
      label: "Refreshing drift detection",
      status: "pending",
      icon: <RefreshCw className="h-5 w-5" />
    }
  ]

  // Update step statuses based on current progress
  const getSteps = () => {
    return steps.map((step, index) => {
      if (error && index === currentStep) {
        return { ...step, status: "error" as const }
      }
      if (index < currentStep) {
        return { ...step, status: "completed" as const }
      }
      if (index === currentStep && !isComplete) {
        return { ...step, status: "active" as const }
      }
      return step
    })
  }

  const displaySteps = getSteps()

  const getStepIcon = (step: ProgressStep) => {
    switch (step.status) {
      case "completed":
        return <CheckCircle2 className="h-5 w-5 text-green-600" />
      case "active":
        return <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />
      case "error":
        return <XCircle className="h-5 w-5 text-red-600" />
      default:
        return <div className="h-5 w-5 opacity-40">{step.icon}</div>
    }
  }

  // The operation cannot be cancelled, so the dialog only closes once it has finished or failed.
  const running = !isComplete && !error
  const close = () => {
    onClose()
    if (onComplete) onComplete(isComplete && isSuccess)
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !running) close() }}>
      <DialogContent className={cn("max-w-md p-8", running && "[&>button:last-child]:hidden")}>
        {/* Header */}
        <div className="text-center mb-8">
          <DialogTitle className="text-2xl font-medium tracking-tight text-gray-900 mb-2">
            {action === "revert" ? "Reverting Policy" : "Restoring Policy"}
          </DialogTitle>
          <DialogDescription className="text-gray-600">
            {policyName}
          </DialogDescription>
        </div>

        {/* Progress Steps */}
        <div className="space-y-2 mb-8">
          {displaySteps.map((step, index) => (
            <div 
              key={step.id}
              className={cn(
                "flex items-center gap-4 px-4 py-3 rounded-2xl transition-all",
                step.status === "active" && "bg-blue-50",
                step.status === "completed" && "bg-green-50",
                step.status === "error" && "bg-red-50"
              )}
            >
              {getStepIcon(step)}
              <div className="flex-1">
                <p className={cn(
                  "font-medium",
                  step.status === "active" && "text-blue-900",
                  step.status === "completed" && "text-green-900",
                  step.status === "error" && "text-red-800",
                  step.status === "pending" && "text-gray-500"
                )}>
                  {step.label}
                </p>
                {step.status === "active" && (
                  <p className="text-xs text-blue-700 mt-1">Processing...</p>
                )}
              </div>
              {index < displaySteps.length - 1 && (
                <div className={cn(
                  "absolute left-7 top-12 w-0.5 h-8",
                  step.status === "completed" ? "bg-green-100" : "bg-gray-200"
                )} />
              )}
            </div>
          ))}
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 rounded-2xl bg-red-50 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
              <div>
                <p className="font-medium text-red-800">Operation Failed</p>
                <p className="text-sm text-red-700 mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Success State */}
        {isComplete && isSuccess && (
          <div className="text-center mb-6">
            <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto mb-4 animate-in zoom-in duration-500" />
            <p className="text-lg font-medium tracking-tight text-gray-900">
              {action === "revert" ? "Policy Reverted Successfully!" : "Policy Restored Successfully!"}
            </p>
            <p className="text-sm text-gray-600 mt-2">
              {action === "revert" 
                ? "The policy has been reverted to its previous state."
                : "A new policy has been created with the previous configuration."
              }
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {isComplete ? (
            <>
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  // Open Intune portal with direct link to the policy if available
                  if (newPolicyId && policyType) {
                    // Construct the direct URL based on policy type
                    let intuneUrl = "https://endpoint.microsoft.com/#view/Microsoft_Intune_DeviceSettings/";
                    
                    // Map policy types to Intune URL paths
                    switch (policyType) {
                      case "Device Configuration":
                      case "deviceConfigurations":
                        intuneUrl += `ConfigurationProfileMenuBlade/~/overview/configurationId/${newPolicyId}`;
                        break;
                      case "Compliance Policy":
                      case "compliancePolicies":
                        intuneUrl += `CompliancePolicyOverviewBlade/~/overview/policyId/${newPolicyId}`;
                        break;
                      case "App Configuration":
                      case "appConfiguration":
                        intuneUrl += `AppConfigurationPolicyMenuBlade/~/overview/policyId/${newPolicyId}`;
                        break;
                      case "App Protection":
                      case "appProtection":
                        intuneUrl += `AppProtectionPolicyMenuBlade/~/overview/policyId/${newPolicyId}`;
                        break;
                      default:
                        // If we can't determine the exact URL, at least go to the policies list
                        intuneUrl = "https://endpoint.microsoft.com/#view/Microsoft_Intune_DeviceSettings/DevicesMenu/~/policyList";
                    }
                    
                    window.open(intuneUrl, "_blank")
                  } else {
                    // Fallback to general Intune portal
                    window.open("https://endpoint.microsoft.com", "_blank")
                  }
                }}
              >
                View in Intune
              </Button>
              <Button
                className="flex-1 bg-coral-600 text-white hover:bg-coral-700"
                onClick={() => {
                  onClose()
                  if (onComplete) onComplete(isSuccess)
                }}
              >
                Done
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              className="w-full"
              disabled={!error}
              onClick={() => {
                onClose()
                if (onComplete) onComplete(false)
              }}
            >
              {error ? "Close" : "Running..."}
            </Button>
          )}
        </div>

        {/* Progress indicator at bottom */}
        {!isComplete && !error && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-100 rounded-b-3xl overflow-hidden">
            <div 
              className="h-full rounded-full bg-coral-500 transition-all duration-1000 ease-out"
              style={{ width: `${(currentStep / steps.length) * 100}%` }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Export a helper hook for managing the modal state
export function useRevertProgress() {
  const [modalState, setModalState] = useState<{
    isOpen: boolean
    action: "revert" | "restore"
    policyName: string
  }>({
    isOpen: false,
    action: "revert",
    policyName: ""
  })

  const openModal = (action: "revert" | "restore", policyName: string) => {
    setModalState({ isOpen: true, action, policyName })
  }

  const closeModal = () => {
    setModalState(prev => ({ ...prev, isOpen: false }))
  }

  const updateProgress = (_step: number, _error?: string) => {
    // This would be used to update the progress from the parent
    // For now, it's a placeholder
  }

  return {
    modalState,
    openModal,
    closeModal,
    updateProgress
  }
}