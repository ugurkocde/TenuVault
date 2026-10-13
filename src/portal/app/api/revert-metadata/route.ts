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

    // Get access token for Azure Storage
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
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

    // Fetch metadata from storage
    const metadataPath = "metadata/revert-history.json"
    const metadataUrl = `https://${storageAccountName}.blob.core.windows.net/intune-backups/${metadataPath}`
    
    const response = await fetch(metadataUrl, {
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
      },
    })
    
    if (!response.ok) {
      if (response.status === 404) {
        // No metadata file exists yet
        return NextResponse.json({ reverts: {} })
      }
      return NextResponse.json(
        { error: "Failed to fetch revert metadata" },
        { status: 500 }
      )
    }

    const data = await response.json()
    
    // If specific policy IDs requested, filter the results
    if (policyIds && Array.isArray(policyIds) && policyIds.length > 0) {
      const filteredData: { reverts: Record<string, unknown> } = {
        reverts: {}
      }
      
      policyIds.forEach(id => {
        if (data.reverts[id]) {
          filteredData.reverts[id] = data.reverts[id]
        }
      })
      
      return NextResponse.json(filteredData)
    }
    
    return NextResponse.json(data)
  } catch (error) {
    console.error("Fetch revert metadata error:", error)
    return NextResponse.json(
      { error: "Internal server error while fetching metadata" },
      { status: 500 }
    )
  }
}