import { isBearerToken } from "../../../../shared/security"
import { signInLogCode } from "../../../../shared/sign-in-errors"
import { discoverAzureResources } from "../../../../shared/azure-discovery"
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tenantId, appId, clientSecret } = body;

    if (!tenantId || !appId || !clientSecret) {
      return NextResponse.json(
        { error: "Missing required credentials" },
        { status: 400 }
      );
    }

    // Get access token for Azure Management API
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
          scope: "https://management.azure.com/.default",
          grant_type: "client_credentials",
        }),
      }
    );

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Azure auth error:", signInLogCode(errorData) ?? "token_request_failed");
      return NextResponse.json(
        { error: "Failed to authenticate with Azure", details: errorData },
        { status: 401 }
      );
    }

    const tokenData = await tokenResponse.json().catch(() => null);
    const accessToken = tokenData?.access_token;
    if (!isBearerToken(accessToken)) {
      console.error("Azure auth error:", "token_invalid_response");
      return NextResponse.json({ error: "Microsoft returned an invalid sign-in response. Try again." }, { status: 502 });
    }

    const result = await discoverAzureResources(fetch, accessToken);
    if (!result) return NextResponse.json({ error: "Failed to access Azure subscriptions" }, { status: 403 });

    return NextResponse.json(result);
  } catch (error) {
    console.error("List resources error:", error);
    return NextResponse.json(
      { error: "Internal server error while listing resources" },
      { status: 500 }
    );
  }
}