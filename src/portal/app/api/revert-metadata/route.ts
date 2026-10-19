import { readLegacyRevertHistory, revertHistoryPath } from "~/lib/policies/revert-history"
import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      tenantId,
      appId,
      clientSecret,
      storageAccountName,
      policyIds // Optional: specific policy IDs to fetch
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }
    const metadataPath = revertHistoryPath(tenantId)
    if (!metadataPath) {
      return NextResponse.json({ error: "Invalid tenant ID" }, { status: 400 })
    }

    // Get access token for Azure Storage
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: appId,
          client_secret: clientSecret,
          scope: "https://storage.azure.com/.default",
          grant_type: "client_credentials",
        }),
      }
    )

    if (!tokenResponse.ok) {
      return NextResponse.json(
        { error: "Failed to authenticate with Azure" },
        { status: 401 }
      )
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token

    // Fetch this tenant's history; a container can be shared by several tenants.
    const read = (name: string) => fetch(`https://${storageAccountName}.blob.core.windows.net/intune-backups/${name.split("/").map(encodeURIComponent).join("/")}`, {
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
      },
    })
    const response = await read(metadataPath)

    if (!response.ok) {
      if (response.status === 404) {
        // No history of its own yet: only this tenant's entries of the old shared file.
        try {
          return NextResponse.json(filterPolicies(await readLegacyRevertHistory(read, tenantId), policyIds))
        } catch (error) {
          console.error("Fetch legacy revert metadata error:", error)
        }
      }
      return NextResponse.json(
        { error: "Failed to fetch revert metadata" },
        { status: 500 }
      )
    }

    const data = await response.json()
    return NextResponse.json(filterPolicies(data, policyIds))
  } catch (error) {
    console.error("Fetch revert metadata error:", error)
    return NextResponse.json(
      { error: "Internal server error while fetching metadata" },
      { status: 500 }
    )
  }
}

/** The history of the requested policies only, or all of it when none are named. */
function filterPolicies(data: { reverts?: Record<string, unknown> }, policyIds: unknown) {
  if (!Array.isArray(policyIds) || policyIds.length === 0) return data
  const filteredData: { reverts: Record<string, unknown> } = {
    reverts: {}
  }

  policyIds.forEach(id => {
    if (typeof id === "string" && data.reverts && Object.hasOwn(data.reverts, id)) {
      filteredData.reverts[id] = data.reverts[id]
    }
  })

  return filteredData
}
