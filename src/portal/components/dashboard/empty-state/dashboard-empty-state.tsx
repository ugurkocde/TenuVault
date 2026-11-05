"use client"

import { useRouter } from "next/navigation"
import { ActionCards } from "./action-cards"

export default function DashboardEmptyState() {
  const router = useRouter()

  return (
    <div>
      <div className="container mx-auto px-4 py-8 md:py-12 space-y-6">
        <ActionCards onStartSetup={() => router.push("/portal/onboarding")} />
      </div>
    </div>
  )
}
