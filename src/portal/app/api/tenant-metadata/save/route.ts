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
      storageAccountName,
      metadata
    } = body

    if (!tenantId || !appId || !clientSecret || !storageAccountName || !metadata) {
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

    // Ensure container exists
    const containerUrl = `https://${storageAccountName}.blob.core.windows.net/${METADATA_CONTAINER}?restype=container`
    
    // Try to create container
    const createContainerResponse = await fetch(containerUrl, {
      method: 'PUT',
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
      },
    })

    // Check if container creation failed (ignore 409 Conflict which means it already exists)
    if (!createContainerResponse.ok && createContainerResponse.status !== 409) {
      const errorText = await createContainerResponse.text()
      console.error("Failed to create container:", errorText)
      // Continue anyway - the container might exist but we don't have permissions to create it
    }

    // Prepare metadata with timestamps
    const fullMetadata: TenantMetadata = {
      tenantId,
      domain: metadata.domain || "",
      tags: metadata.tags || [],
      environment: metadata.environment ?? null,
      license: metadata.license ?? null,
      ...metadata,
      metadata: {
        ...metadata.metadata,
        lastModified: new Date().toISOString(),
        createdAt: metadata.metadata?.createdAt || new Date().toISOString(),
      }
    }

    // Save metadata to blob
    const blobUrl = `https://${storageAccountName}.blob.core.windows.net/${METADATA_CONTAINER}/${encodeURIComponent(tenantId)}/metadata.json`
    
    const uploadResponse = await fetch(blobUrl, {
      method: 'PUT',
      headers: {
        'x-ms-version': '2021-12-02',
        'x-ms-date': new Date().toUTCString(),
        'Authorization': `Bearer ${accessToken}`,
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fullMetadata, null, 2),
    })

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text()
      console.error("Failed to save metadata:", errorText)
      
      // If container doesn't exist, provide helpful message
      if (errorText.includes("ContainerNotFound")) {
        return NextResponse.json({ 
          error: "Container not found",
          details: "The 'tenant-metadata' container does not exist. Please create it manually in your Azure Storage account or ensure the app has 'Storage Blob Data Contributor' role to create containers."
        }, { status: 404 })
      }
      
      // If authorization error, provide helpful message
      if (errorText.includes("AuthorizationPermissionMismatch")) {
        return NextResponse.json({ 
          error: "Missing storage permissions",
          details: "Please ensure the app has 'Storage Blob Data Contributor' role on the storage account."
        }, { status: 403 })
      }
      
      return NextResponse.json(
        { error: "Failed to save metadata", details: errorText },
        { status: 500 }
      )
    }

    return NextResponse.json({ 
      success: true,
      message: "Metadata saved successfully",
      metadata: fullMetadata
    })

  } catch (error) {
    console.error("Error saving tenant metadata:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}