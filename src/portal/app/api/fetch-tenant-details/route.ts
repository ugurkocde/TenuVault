import { type NextRequest, NextResponse } from "next/server";

interface GraphApiResponse {
  value?: any[];
  [key: string]: any;
}

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

    // Get access token for Microsoft Graph API
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
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      }
    );

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Graph auth error:", errorData);
      return NextResponse.json(
        { error: "Failed to authenticate with Microsoft Graph", details: errorData },
        { status: 401 }
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Helper function to make Graph API calls
    const callGraphApi = async (endpoint: string, useBeta: boolean = false): Promise<GraphApiResponse | null> => {
      try {
        const apiVersion = useBeta ? "beta" : "v1.0";
        const response = await fetch(`https://graph.microsoft.com/${apiVersion}${endpoint}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(endpoint.includes("$count=true") ? { ConsistencyLevel: "eventual" } : {}),
          },
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Graph API error for ${endpoint}: ${response.status} - ${errorText}`);
          return null;
        }
        
        // Check if response has content
        const contentType = response.headers.get("content-type");
        const contentLength = response.headers.get("content-length");
        
        // If no content or content-length is 0, return empty result
        if (contentLength === "0" || !contentType?.includes("application/json")) {
          console.log(`Empty or non-JSON response for ${endpoint}`);
          return { value: [] };
        }
        
        const text = await response.text();
        if (!text || text.trim() === "") {
          console.log(`Empty response body for ${endpoint}`);
          return { value: [] };
        }
        
        try {
          return JSON.parse(text);
        } catch (parseError) {
          console.error(`Failed to parse JSON for ${endpoint}:`, parseError, "Response text:", text);
          return null;
        }
      } catch (error) {
        console.error(`Error calling ${endpoint}:`, error);
        return null;
      }
    };

    // Most counts come from $count with $top=1, so they stay correct above one Graph page and
    // no collection is enumerated just to be counted. All reads run in parallel. A failed
    // read stays null: reporting it as zero would show a tenant with no users, no policies
    // or 0 percent compliant devices when the truth is that the count could not be read.
    const countOf = (data: GraphApiResponse | null): number | null => {
      if (!data) return null;
      const count = data["@odata.count"];
      return typeof count === "number" ? count : data.value?.length || 0;
    };
    const failed: string[] = [];
    // Settings Catalog policies reject $count (400 "Query option 'Count' is not allowed") and
    // report only the page size in @odata.count, so they are counted by reading their ids page
    // by page. The next links stay on Microsoft Graph's beta endpoint, and a tenant with more
    // policies than the page bound is left uncounted instead of undercounted.
    const BETA = "https://graph.microsoft.com/beta";
    const MAX_COUNT_PAGES = 100;
    const pagedCount = async (endpoint: string, label: string): Promise<number | null> => {
      let next: string | undefined = `${endpoint}?$select=id&$top=100`;
      let total = 0;
      for (let page = 0; next && page < MAX_COUNT_PAGES; page++) {
        const data = await callGraphApi(next, true);
        if (!data || !Array.isArray(data.value)) break;
        total += data.value.length;
        const link: unknown = data["@odata.nextLink"];
        if (typeof link !== "string") return total;
        next = link.startsWith(`${BETA}/`) ? link.slice(BETA.length) : undefined;
      }
      failed.push(label);
      return null;
    };
    const countEndpoint = (endpoint: string, label: string, useBeta: boolean = false): Promise<number | null> =>
      callGraphApi(`${endpoint}${endpoint.includes("?") ? "&" : "?"}$count=true&$top=1`, useBeta).then((data) => {
        const count = countOf(data);
        if (count === null) failed.push(label);
        return count;
      });

    const [
      orgData,
      deviceConfigCount,
      compliancePolicyCount,
      configPolicyCount,
      iosAppPolicyCount,
      androidAppPolicyCount,
      windowsInfoPolicyCount,
      mdmWindowsInfoPolicyCount,
      totalDevices,
      compliantDevices,
      userCount,
    ] = await Promise.all([
      callGraphApi("/organization"),
      countEndpoint("/deviceManagement/deviceConfigurations", "device configurations"),
      countEndpoint("/deviceManagement/deviceCompliancePolicies", "compliance policies"),
      // Settings Catalog policies need the beta API for full results.
      pagedCount("/deviceManagement/configurationPolicies", "configuration policies"),
      countEndpoint("/deviceAppManagement/iosManagedAppProtections", "iOS app protection policies"),
      countEndpoint("/deviceAppManagement/androidManagedAppProtections", "Android app protection policies"),
      countEndpoint("/deviceAppManagement/windowsInformationProtectionPolicies", "Windows information protection policies"),
      countEndpoint("/deviceAppManagement/mdmWindowsInformationProtectionPolicies", "MDM Windows information protection policies"),
      countEndpoint("/deviceManagement/managedDevices", "devices"),
      countEndpoint("/deviceManagement/managedDevices?$filter=complianceState%20eq%20'compliant'", "compliant devices"),
      countEndpoint("/users", "users"),
    ]);
    // The organization names the tenant, so without it the details are refused. A count that
    // could not be read is returned as null and listed in `unavailable`, never as zero, and a
    // total that depends on it is null too. The user count, for example, needs a directory
    // permission the TenuVault app registration does not request.
    if (!orgData?.value?.[0]) {
      return NextResponse.json(
        { error: "The organization could not be read from Microsoft Graph. Check the app registration permissions and try again." },
        { status: 502 }
      );
    }
    if (failed.length > 0) console.error(`Tenant details without: ${failed.join(", ")}`);
    const organization = orgData.value[0];
    const sum = (...counts: Array<number | null>): number | null =>
      counts.every((count): count is number => count !== null) ? counts.reduce((a, b) => a + b, 0) : null;
    const appPolicyCount = sum(iosAppPolicyCount, androidAppPolicyCount, windowsInfoPolicyCount, mdmWindowsInfoPolicyCount);
    const complianceRate = totalDevices === null || compliantDevices === null ? null
      : totalDevices > 0 ? Math.round((compliantDevices / totalDevices) * 100) : 0;

    // Prepare tenant details
    const tenantDetails = {
      organization: {
        id: organization.id || tenantId,
        displayName: organization.displayName || "Unknown Organization",
        verifiedDomains: organization.verifiedDomains || [],
        primaryDomain: organization.verifiedDomains?.find((d: any) => d.isDefault)?.name || 
                       organization.verifiedDomains?.[0]?.name || 
                       "pending.onmicrosoft.com",
      },
      statistics: {
        userCount,
        deviceCount: totalDevices,
        complianceRate,
        policies: {
          deviceConfigurations: deviceConfigCount,
          compliancePolicies: compliancePolicyCount,
          configurationPolicies: configPolicyCount,
          appProtectionPolicies: appPolicyCount,
          total: sum(deviceConfigCount, compliancePolicyCount, configPolicyCount, appPolicyCount),
        },
      },
      unavailable: failed,
    };

    return NextResponse.json(tenantDetails);
  } catch (error) {
    console.error("Fetch tenant details error:", error);
    return NextResponse.json(
      { error: "Internal server error while fetching tenant details" },
      { status: 500 }
    );
  }
}