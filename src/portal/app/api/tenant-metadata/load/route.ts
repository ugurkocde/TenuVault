import { signInLogCode } from "../../../../../shared/sign-in-errors"
import { isGuid } from "../../../../../shared/security"
import { type NextRequest, NextResponse } from "next/server"
import type { TenantMetadata } from "~/types/tenant-metadata"

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

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token

    // Try to load metadata from blob
    const blobUrl = `https://${storageAccountName}.blob.core.windows.net/${METADATA_CONTAINER}/${encodeURIComponent(tenantId)}/metadata.json`
    
    const metadataResponse = await fetch(blobUrl, {
      method: 'GET',
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
      },
    })

    if (!metadataResponse.ok) {
      if (metadataResponse.status === 404) {
        // No metadata found - this is not an error
        console.log(`No metadata found for tenant ${tenantId} in container tenant-metadata`)
        return NextResponse.json({ 
          exists: false,
          message: "No metadata found for this tenant"
        })
      }

      const errorText = await metadataResponse.text()
      console.error("Failed to load metadata:", errorText)
      console.error("Storage account:", storageAccountName)
      console.error("Blob URL:", blobUrl)
      
      // If authorization error, provide helpful message
      if (errorText.includes("AuthorizationPermissionMismatch")) {
        return NextResponse.json({ 
          error: "Missing storage permissions",
          details: "Please ensure the app has 'Storage Blob Data Reader' or 'Storage Blob Data Contributor' role on the storage account."
        }, { status: 403 })
      }
      
      return NextResponse.json(
        { error: "Failed to load metadata", details: errorText },
        { status: 500 }
      )
    }

    const metadata: TenantMetadata = await metadataResponse.json()

    console.log(`Successfully loaded metadata for tenant ${tenantId}`)
    console.log("Metadata contains Azure resources:", !!metadata.azureResources)
    
    // Validate Azure resources still exist (optional enhancement)
    if (metadata.azureResources) {
      console.log("Azure resources in metadata:", {
        storageAccount: metadata.azureResources.storageAccountName,
        resourceGroup: metadata.azureResources.resourceGroupName,
        automationAccount: metadata.azureResources.automationAccountName
      })
    }

    return NextResponse.json({ 
      exists: true,
      metadata,
      message: "Metadata loaded successfully"
    })

  } catch (error) {
    console.error("Error loading tenant metadata:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}