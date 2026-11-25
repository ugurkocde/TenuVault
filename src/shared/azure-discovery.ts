import { assertArmPage } from "./security"

export interface AzureStorageAccount {
  name: string
  subscriptionId: string
  resourceGroup: string
  location: string
}

/** List the subscriptions and storage accounts visible to the signed-in Azure account. */
export async function discoverAzureResources(fetchImpl: typeof fetch, accessToken: string) {
  const headers = { Authorization: `Bearer ${accessToken}` };

  // One ARM GET, retried when ARM throttles (429) as its Retry-After asks. Null when it fails.
  const getPage = async <T>(url: string): Promise<{ value?: T[]; nextLink?: string } | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(url, { headers });
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
  const listAll = async <T>(url: string): Promise<T[] | null> => {
    const items: T[] = [];
    const seen = new Set<string>();
    for (let next: string | undefined = url; next; ) {
      assertArmPage(next, seen);
      const page: { value?: T[]; nextLink?: string } | null = await getPage<T>(next);
      if (!page) return null;
      items.push(...(page.value || []));
      next = page.nextLink;
    }
    return items;
  };

  const subscriptions = await listAll<{ subscriptionId: string; displayName: string }>("https://management.azure.com/subscriptions?api-version=2022-12-01");
  if (!subscriptions) return null;

  // A subscription whose storage accounts cannot be listed is skipped, not fatal.
  // A few subscriptions at a time keeps tenants with many subscriptions under ARM's read limits.
  const perSubscription: Array<Array<AzureStorageAccount & { id: string; kind: string; sku: unknown }>> = [];
  let nextIndex = 0;
  const worker = async () => {
    for (let i = nextIndex++; i < subscriptions.length; i = nextIndex++) {
      const subscriptionId = subscriptions[i]!.subscriptionId;
      const accounts = await listAll<{ id: string; name: string; location: string; kind: string; sku: unknown }>(
        `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-05-01`
      );
      perSubscription[i] = (accounts || []).map((sa) => ({
        id: sa.id,
        name: sa.name,
        subscriptionId,
        resourceGroup: sa.id.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "",
        location: sa.location,
        kind: sa.kind,
        sku: sa.sku
      }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, subscriptions.length) }, worker));

  return {
    subscriptions: subscriptions
      .map((sub) => ({ id: sub.subscriptionId, name: sub.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    storageAccounts: perSubscription.flat().sort((a, b) => a.name.localeCompare(b.name))
  };

}
