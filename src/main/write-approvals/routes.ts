import type { RouteModule } from "../api/host"
import type { WriteApprovals } from "./service"

export function writeApprovalRoutes(approvals: WriteApprovals): Record<string, RouteModule> {
  return {
    "/api/tenant-write-approvals": {
      POST: async request => {
        const body = await request.json().catch(() => null)
        if (!body || typeof body.tenantId !== "string") return Response.json({ error: "Choose a tenant." }, { status: 400 })
        try {
          switch (body.action) {
            case "list": break
            case "enable":
              if (body.confirmManagedCutover !== true) return Response.json({ error: "Confirm the managed cutover to enable tenant write approval." }, { status: 400 })
              await approvals.enable(body.tenantId)
              break
            case "disable": await approvals.disable(body.tenantId); break
            case "close-interrupted":
              if (body.confirmReconciled !== true) return Response.json({ error: "Check the outcome in Intune before closing this request." }, { status: 400 })
              await approvals.releaseInterrupted(body.tenantId, body.requestId)
              break
            case "approve":
            case "reject":
            case "cancel": await approvals.decide(body.tenantId, body.requestId, body.action); break
            default: return Response.json({ error: "Unknown approval action." }, { status: 400 })
          }
          return Response.json(await approvals.inbox(body.tenantId))
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "The approval action could not be verified." }, { status: 409 })
        }
      },
    },
  }
}
