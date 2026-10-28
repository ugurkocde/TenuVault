import { assertArmPage } from "../../../../shared/security"
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
      console.error("Azure auth error:", errorData);
      return NextResponse.json(
        { error: "Failed to authenticate with Azure", details: errorData },
        { status: 401 }
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    const headers = { Authorization: `Bearer ${accessToken}` };

    // One ARM GET, retried when ARM throttles (429) as its Retry-After asks. Null when it fails.
    const getPage = async (url: string): Promise<{ value?: any[]; nextLink?: string } | null> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { headers });
          if (response.ok) return await response.json();
          if (response.status !== 429) return null;
          const retryAfter = Number(response.headers.get("retry-after") ?? 2);
          await new Promise((resolve) => setTimeout(resolve, Math.min(Number.isFinite(retryAfter) ? retryAfter : 2, 10) * 1000));
        } catch {
          return null;
        }
      }
      return null;
    };

    // ARM pages large lists; follow nextLink so no subscription or storage account is dropped.
    const listAll = async (url: string): Promise<any[] | null> => {
      const items: any[] = [];
      const seen = new Set<string>();
      for (let next: string | undefined = url; next; ) {
        assertArmPage(next, seen);
        const page = await getPage(next);
        if (!page) return null;
        items.push(...(page.value || []));
        next = page.nextLink;
      }
      return items;
    };

    const subscriptions = await listAll("https://management.azure.com/subscriptions?api-version=2022-12-01");
    if (!subscriptions) {
      console.error("Failed to get subscriptions");
      return NextResponse.json(
        { error: "Failed to access Azure subscriptions" },
        { status: 403 }
      );
    }

    // A subscription whose storage accounts cannot be listed is skipped, not fatal.
    // A few subscriptions at a time keeps tenants with many subscriptions under ARM's read limits.
    const perSubscription: any[][] = new Array(subscriptions.length);
    let nextIndex = 0;
    const worker = async () => {
      for (let i = nextIndex++; i < subscriptions.length; i = nextIndex++) {
        const subscriptionId = subscriptions[i].subscriptionId;
        const accounts = await listAll(
          `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01`
        );
        perSubscription[i] = (accounts || []).map((sa: any) => ({
          id: sa.id,
          name: sa.name,
          subscriptionId,
          resourceGroup: sa.id.match(/resourceGroups\/([^\/]+)/i)?.[1] ?? "",
          location: sa.location,
          kind: sa.kind,
          sku: sa.sku
        }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, subscriptions.length) }, worker));

    const result = {
      subscriptions: subscriptions
        .map((sub: any) => ({ id: sub.subscriptionId, name: sub.displayName }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      storageAccounts: perSubscription.flat().sort((a: any, b: any) => a.name.localeCompare(b.name))
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("List resources error:", error);
    return NextResponse.json(
      { error: "Internal server error while listing resources" },
      { status: 500 }
    );
  }
}