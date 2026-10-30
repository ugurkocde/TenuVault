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

    // Counts come from $count with $top=1, so they stay correct above one Graph page and
    // no collection is enumerated just to be counted. All reads run in parallel. A failed
    // read stays null: reporting it as zero would show a tenant with no users, no policies
    // or 0 percent compliant devices when the truth is that the count could not be read.
    const countOf = (data: GraphApiResponse | null): number | null => {
      if (!data) return null;
      const count = data["@odata.count"];
      return typeof count === "number" ? count : data.value?.length || 0;
    };
    const failed: string[] = [];
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
      countEndpoint("/deviceManagement/configurationPolicies", "configuration policies", true),
      countEndpoint("/deviceAppManagement/iosManagedAppProtections", "iOS app protection policies"),
      countEndpoint("/deviceAppManagement/androidManagedAppProtections", "Android app protection policies"),
      countEndpoint("/deviceAppManagement/windowsInformationProtectionPolicies", "Windows information protection policies"),
      countEndpoint("/deviceAppManagement/mdmWindowsInformationProtectionPolicies", "MDM Windows information protection policies"),
      countEndpoint("/deviceManagement/managedDevices", "devices"),
      countEndpoint("/deviceManagement/managedDevices?$filter=complianceState%20eq%20'compliant'", "compliant devices"),
      countEndpoint("/users", "users"),
    ]);
    if (!orgData?.value?.[0]) failed.unshift("organization");
    if (failed.length > 0) {
      return NextResponse.json(
        { error: `Some tenant details could not be read from Microsoft Graph: ${failed.join(", ")}. Check the app registration permissions and try again.` },
        { status: 502 }
      );
    }
    const organization = orgData!.value![0];
    // Every count is present here: a failed read returned 502 above.
    const appPolicyCount = iosAppPolicyCount! + androidAppPolicyCount! + windowsInfoPolicyCount! + mdmWindowsInfoPolicyCount!;
    const complianceRate = totalDevices! > 0 ? Math.round((compliantDevices! / totalDevices!) * 100) : 0;

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
          total: deviceConfigCount! + compliancePolicyCount! + configPolicyCount! + appPolicyCount,
        },
      },
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