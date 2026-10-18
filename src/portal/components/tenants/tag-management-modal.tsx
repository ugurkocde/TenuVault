"use client"

import { useState } from "react"
import { X, Plus, Tag } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Badge } from "~/components/ui/badge"
import { cn } from "~/lib/utils"

interface TagManagementModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tenantName: string
  currentTags: string[]
  availableTags: string[]
  onTagsUpdate: (tags: string[]) => void
}

const predefinedTags = [
  "Production",
  "Development",
  "Testing",
  "Staging",
  "Critical",
  "Priority",
  "Pilot",
  "Legacy",
  "Migration",
  "Compliance",
  "GDPR",
  "HIPAA",
  "SOC2",
  "ISO27001",
  "Finance",
  "Healthcare",
  "Education",
  "Retail",
  "Manufacturing",
  "Technology",
  "Europe",
  "Americas",
  "APAC",
  "Global",
]

const tagColors: Record<string, string> = {
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
  Finance: "blue",
  Healthcare: "green",
  Education: "orange",
  Retail: "pink",
  Manufacturing: "gray",
  Technology: "blue",
  Europe: "blue",
  Americas: "green",
  APAC: "yellow",
  Global: "purple",
}

export function TagManagementModal({
  open,
  onOpenChange,
  tenantName,
  currentTags,
  availableTags,
  onTagsUpdate,
}: TagManagementModalProps) {
  const [selectedTags, setSelectedTags] = useState<string[]>(currentTags)
  const [customTag, setCustomTag] = useState("")
  const [showCustomInput, setShowCustomInput] = useState(false)

  const allAvailableTags = Array.from(
    new Set([...predefinedTags, ...availableTags])
  ).sort()

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag)
        ? prev.filter((t) => t !== tag)
        : [...prev, tag]
    )
  }

  const addCustomTag = () => {
    const trimmedTag = customTag.trim()
    if (trimmedTag && !selectedTags.includes(trimmedTag)) {
      setSelectedTags((prev) => [...prev, trimmedTag])
      setCustomTag("")
      setShowCustomInput(false)
    }
  }

  const removeTag = (tag: string) => {
    setSelectedTags((prev) => prev.filter((t) => t !== tag))
  }

  const handleSave = () => {
    onTagsUpdate(selectedTags)
    onOpenChange(false)
  }

  const getTagVariant = (tag: string): any => {
    return (tagColors[tag] || "gray") as any
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-medium tracking-tight">
            <Tag className="h-5 w-5 text-blue-700" />
            Manage Tags for {tenantName}
          </DialogTitle>
          <DialogDescription>
            Add or remove tags to organize and filter your tenants
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Current Tags */}
          <div>
            <h3 className="text-xs font-medium text-gray-500 mb-3">
              Current Tags ({selectedTags.length})
            </h3>
            <div className="flex flex-wrap items-center content-center gap-2 min-h-[40px] p-4 bg-gray-50 rounded-2xl">
              {selectedTags.length === 0 ? (
                <span className="text-sm text-gray-500">No tags selected</span>
              ) : (
                selectedTags.map((tag) => (
                  <Badge
                    key={tag}
                    variant={getTagVariant(tag)}
                    className="group cursor-pointer"
                    onClick={() => removeTag(tag)}
                  >
                    {tag}
                    <X className="ml-1 h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </Badge>
                ))
              )}
            </div>
          </div>

          {/* Available Tags */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-gray-500">
                Available Tags
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCustomInput(!showCustomInput)}
              >
                <Plus className="h-4 w-4 mr-1" />
                Custom Tag
              </Button>
            </div>

            {/* Custom Tag Input */}
            {showCustomInput && (
              <div className="flex gap-2 mb-3">
                <Input
                  placeholder="Enter custom tag..."
                  value={customTag}
                  onChange={(e) => setCustomTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      addCustomTag()
                    }
                    if (e.key === "Escape") {
                      setShowCustomInput(false)
                      setCustomTag("")
                    }
                  }}
                  autoFocus
                />
                <Button onClick={addCustomTag} size="sm" className="bg-coral-600 text-white hover:bg-coral-700">
                  Add
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowCustomInput(false)
                    setCustomTag("")
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}

            {/* Tag Grid */}
            <div className="grid grid-cols-4 gap-2 max-h-[300px] overflow-y-auto p-4 bg-gray-50 rounded-2xl">
              {allAvailableTags.map((tag) => {
                const isSelected = selectedTags.includes(tag)
                return (
                  <Badge
                    key={tag}
                    variant={isSelected ? getTagVariant(tag) : "outline"}
                    className={cn(
                      "cursor-pointer transition-all",
                      isSelected && "ring-2 ring-coral-500"
                    )}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </Badge>
                )
              })}
            </div>
          </div>

          {/* Tag Categories */}
          <div className="text-xs text-gray-500 space-y-1">
            <p className="font-medium">Quick categories:</p>
            <div className="flex flex-wrap gap-4">
              <button
                className="text-blue-700 hover:underline"
                onClick={() => {
                  setSelectedTags([
                    "Production",
                    "Critical",
                    "Priority",
                    "Compliance",
                  ])
                }}
              >
                Production Setup
              </button>
              <button
                className="text-blue-700 hover:underline"
                onClick={() => {
                  setSelectedTags(["Development", "Testing", "Staging"])
                }}
              >
                Non-Production
              </button>
              <button
                className="text-blue-700 hover:underline"
                onClick={() => {
                  setSelectedTags(["GDPR", "HIPAA", "SOC2", "ISO27001"])
                }}
              >
                Compliance
              </button>
              <button
                className="text-red-600 hover:underline"
                onClick={() => setSelectedTags([])}
              >
                Clear All
              </button>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} className="bg-coral-600 text-white hover:bg-coral-700">
            Save Tags
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}