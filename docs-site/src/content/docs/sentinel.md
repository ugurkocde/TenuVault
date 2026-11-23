---
title: Send alerts to Microsoft Sentinel
description: Send TenuVault webhook events through Azure Logic Apps to a custom Log Analytics table and query them in Microsoft Sentinel.
---

An Azure Logic App can receive [TenuVault webhook alerts](/notifications/#webhook) from the desktop app or the Azure watcher and write them to the Azure Monitor Logs Ingestion API. Use the Log Analytics workspace connected to Microsoft Sentinel to query the same events in Sentinel.

## Create the table and ingestion endpoint

Use a Log Analytics workspace where you can create tables and a data collection rule (DCR). You also need permission to create a Logic App and assign an Azure role on the DCR.

1. In the Azure portal, open **Monitor** > **Data Collection Endpoints** and create a data collection endpoint (DCE) in the workspace's region. For this public Azure recipe, enable public network access on the DCE. Copy its **Logs ingestion URI**.
2. In the workspace, open **Tables** > **Create** > **New custom log (DCR based)**. Enter `TenuVaultAlerts` as the name. Azure adds `_CL`. Create a new DCR and select your DCE. Keep the table on the **Analytics** plan for Sentinel analytics rules.
3. Save the following sample as `tenuvault-sample.json` and upload it in the custom log wizard. The wizard uses it to infer the columns.

   ```json
   [
     {
       "TimeGenerated": "2026-11-23T12:00:00Z",
       "RawData": "{\"schema\":\"tenuvault.notification/v1\",\"type\":\"test\",\"test\":true}"
     }
   ]
   ```

4. Verify the output schema has `TimeGenerated` (datetime) and `RawData` (string). If the wizard inferred the timestamp as a string, use the transformation `source | extend TimeGenerated = todatetime(TimeGenerated)`. Create the table.
5. Open the DCR in **Monitor** > **Data Collection Rules**. From its **JSON View**, copy `properties.immutableId` (starts with `dcr-`) and the input stream name from `properties.streamDeclarations`. For the table above, the portal wizard uses `Custom-TenuVaultAlerts_CL`.

[Microsoft's portal guide for the Logs Ingestion API](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/tutorial-logs-ingestion-portal) covers this setup. The Logic App's managed identity takes the place of the guide's app registration.

## Create the webhook receiver

1. Create a **Consumption** Logic App and turn on its **System assigned** identity under **Identity**. On the DCR, open **Access control (IAM)** and assign **Monitoring Metrics Publisher** to that managed identity. Allow up to 30 minutes for the assignment to take effect. [Managed identity setup](https://learn.microsoft.com/en-us/azure/logic-apps/authenticate-with-managed-identity?tabs=consumption).
2. In the workflow designer, add the built-in **Request** trigger **When an HTTP request is received**. Use `POST` and leave the request body schema empty. Save and copy the full **HTTP URL**, including its `sig` query parameter. Keep this URL private because it grants permission to invoke the workflow. [Request trigger and callback URL](https://learn.microsoft.com/en-us/azure/connectors/connectors-native-reqres).
3. Add the built-in **HTTP** action with method `POST`. Use the Logs ingestion URI from the DCE as `<logs-ingestion-uri>`, without a trailing slash, and replace the DCR and stream placeholders. [Logs Ingestion API request reference](https://learn.microsoft.com/en-us/rest/api/ingestion/upload/upload?view=rest-ingestion-2023-01-01).

   ```text
   <logs-ingestion-uri>/dataCollectionRules/<dcr-immutable-id>/streams/<input-stream>?api-version=2023-01-01
   ```

   - Set the `Content-Type` header to `application/json`.
   - Set **Authentication** to **Managed identity**, select **System-assigned managed identity**, and set **Audience** to `https://monitor.azure.com` for Azure public cloud. [Logs Ingestion API token audience](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview#request-headers).
   - In the **Body** expression editor, paste the expression below. It creates the one-row JSON array the API expects, uses the event's time for `TimeGenerated`, and preserves the full envelope as a string in `RawData`. [Logic Apps expression reference](https://learn.microsoft.com/en-us/azure/logic-apps/expression-functions-reference).

     ```text
     json(concat('[', string(addProperty(addProperty(json('{}'), 'TimeGenerated', triggerBody()?['occurredAt']), 'RawData', string(triggerBody()))), ']'))
     ```

   - In the HTTP action's settings, set **Retry policy** to **None** so the sender can handle retries.
4. Add one built-in **Response** action directly after **HTTP**. Set **Run after** to run when **HTTP** succeeded, failed, or timed out. Leave the response body empty. Enter this expression in **Status Code** and save the workflow. The `502` lets TenuVault treat an ingestion failure as a delivery failure and retry it. [Response action](https://learn.microsoft.com/en-us/azure/connectors/connectors-native-reqres) and [run-after settings](https://learn.microsoft.com/en-us/azure/logic-apps/error-exception-handling).

   ```text
   if(equals(actions('HTTP')?['status'], 'Succeeded'), 204, 502)
   ```
5. In TenuVault, go to **Alerts** > **Channels** and add a **Webhook** channel with the workflow's HTTP URL. Select **Send test**, then choose this channel on the alerts you want to route. For the Azure watcher, use the same URL with `-WebhookUrl` in the [watcher setup script](/notifications/#alerts-while-this-computer-is-off-the-azure-watcher).

If the test fails, open the Logic App's run history and inspect the HTTP action. A `403` points to the identity's DCR role or a role assignment still propagating. A `404` can indicate an incorrect DCR ID or input stream. [Microsoft's ingestion troubleshooting steps](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/tutorial-logs-ingestion-portal#troubleshoot-common-issues).

## Find the events

In the workspace's **Logs** view, run this query. Initial ingestion can take several minutes. After you see the test event, add `| where Test == false` after `project` to focus on live alerts.

```kusto
TenuVaultAlerts_CL
| where TimeGenerated > ago(24h)
| extend Event = parse_json(RawData)
| where tostring(Event.schema) == "tenuvault.notification/v1"
| extend EventId = tostring(Event.eventId)
| summarize arg_max(TimeGenerated, *) by EventId
| project TimeGenerated, EventId, TenantId = tostring(Event.tenant.id),
          EventType = tostring(Event.type), Severity = tostring(Event.severity),
          Title = tostring(Event.title), Source = tostring(Event.source),
          Test = coalesce(tobool(Event.test), false)
| order by TimeGenerated desc
```

`eventId` stays the same on retry, so the query shows one row per event. The ingestion table can still contain duplicate rows. [Kusto `parse_json()`](https://learn.microsoft.com/en-us/kusto/query/parse-json-function) and [`arg_max()`](https://learn.microsoft.com/en-us/kusto/query/arg-max-aggregation-function).

## Webhook envelope

Each HTTPS POST contains a single JSON object. The desktop app and Azure watcher use the same fields.

| Field | Value |
| --- | --- |
| `schema` | `tenuvault.notification/v1` |
| `eventId` | Stable event ID, also sent in `X-TenuVault-Event-Id` |
| `type` | Event type, such as `backup.failed`, `intune.change`, `entra.change`, or `test` |
| `severity` | `info`, `warning`, or `critical` |
| `tenant` | Object with `id` and optional `name` |
| `occurredAt` | ISO 8601 event timestamp |
| `title`, `summary` | Short event text |
| `details` | Array of `{ label, value }` pairs |
| `items` | Array of items with `title` and optional `detail`, `actor`, `at`, and `change`. `actor` can contain an opted-in actor UPN. |
| `moreCount` | Number of additional items not shown |
| `source` | `desktop` or `azure-watcher` |
| `test` | Optional. `true` for a test delivery. |

On change events, `items[].change` contains `auditId`, `changeType`, `category`, and optional `resourceId`, `resourceName`, `resourceType`, `count`, `settings`, and `settingsMore`. `settings` contains changed setting names. See [Webhook fields for changes](/notifications/#webhook-fields-for-changes).

## Verify signatures (optional)

The minimal workflow uses the signed Logic App callback URL for access. To also authenticate the event bytes, put an HTTP-triggered Azure Function in front of the Logic App and configure TenuVault to call the Function. Keep the downstream callback URL and HMAC secret in the Function's settings. In the desktop channel enter **Secret value**, turn on **Sign requests with the secret value (HMAC)**, and leave **Secret header name** empty so the shared secret stays off the wire. For the Azure watcher, supply the same key with `-WebhookSecret`.

In the Function, read the header values case-insensitively and capture the original body bytes before parsing JSON. For example, a Node.js Azure Function can read `await request.arrayBuffer()` and convert it to a `Buffer`. [Azure Functions HTTP request reference](https://learn.microsoft.com/en-us/javascript/api/@azure/functions/httprequest).

1. Require `X-TenuVault-Timestamp` as Unix seconds and `X-TenuVault-Signature` as a 64-character hex digest. Reject missing or malformed headers and timestamps outside your allowed clock skew, for example five minutes either side of the current time.
2. Compute HMAC-SHA256 with the UTF-8 shared secret as the key. Feed it the exact timestamp header followed by a literal `.` as UTF-8, then the original body bytes. Whitespace and key order must match the received bytes, so verify before parsing or reserializing the JSON.
3. Decode the header's hex digest and compare it with the computed bytes using a constant-time comparison. Return `401` if the check fails. On success, forward the body to the Logic App and return its status to TenuVault. Use `eventId` for deduplication, since clock checks alone still allow a replay within the time window.

## Other SIEMs

For a SIEM that accepts HTTPS webhooks, use its public ingestion URL as the TenuVault channel URL. If it expects a different format, put a receiver in front to verify the signature and map this envelope to the expected fields. Preserve `eventId` for deduplication and `occurredAt` for event time, and return a success status only after accepting the event.
