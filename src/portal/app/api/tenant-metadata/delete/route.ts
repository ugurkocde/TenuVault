import { signInLogCode } from "../../../../../shared/sign-in-errors"
import { isGuid } from "../../../../../shared/security"
import { type NextRequest, NextResponse } from "next/server"

const METADATA_CONTAINER = "tenant-metadata"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { 
      tenantId, 
      appId, 
      clientSecret,
      storageAccountName
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      )
    }
    if (!isGuid(tenantId)) {
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
      const errorData = await tokenResponse.text()
      console.error("Azure auth error:", signInLogCode(errorData) ?? "token_request_failed")
      return NextResponse.json(
        { error: "Failed to authenticate with Azure" },
        { status: 401 }
      )
    }

    const tokenData = await tokenResponse.json().catch(() => null)
    const accessToken = tokenData?.access_token
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      console.error("Azure auth error:", "token_invalid_response")
      return NextResponse.json({ error: "Microsoft returned an invalid sign-in response. Try again." }, { status: 502 })
    }

    // Delete metadata blob
    const blobUrl = `https://${storageAccountName}.blob.core.windows.net/${METADATA_CONTAINER}/${encodeURIComponent(tenantId)}/metadata.json`
    
    const deleteResponse = await fetch(blobUrl, {
      method: 'DELETE',
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
        'x-ms-delete-snapshots': 'include', // Also delete any snapshots
      },
    })

    if (!deleteResponse.ok) {
      if (deleteResponse.status === 404) {
        // Already deleted or never existed
        return NextResponse.json({ 
          success: true,
          message: "Metadata already deleted or did not exist"
        })
      }

      const errorText = await deleteResponse.text()
      console.error("Failed to delete metadata:", errorText)
      
      // If authorization error, provide helpful message
      if (errorText.includes("AuthorizationPermissionMismatch")) {
        return NextResponse.json({ 
          error: "Missing storage permissions",
          details: "Please ensure the app has 'Storage Blob Data Contributor' role on the storage account."
        }, { status: 403 })
      }
      
      return NextResponse.json(
        { error: "Failed to delete metadata", details: errorText },
        { status: 500 }
      )
    }

    // Optionally, try to delete the tenant folder if empty
    // This is a nice-to-have cleanup step
    const folderUrl = `https://${storageAccountName}.blob.core.windows.net/${METADATA_CONTAINER}/${encodeURIComponent(tenantId)}`
    await fetch(folderUrl, {
      method: 'DELETE',
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
      },
    }).catch(() => {
      // Ignore folder deletion errors - it might not be empty
    })

    return NextResponse.json({ 
      success: true,
      message: "Metadata deleted successfully"
    })

  } catch (error) {
    console.error("Error deleting tenant metadata:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}