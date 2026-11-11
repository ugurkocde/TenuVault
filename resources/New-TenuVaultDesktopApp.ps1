<#
.SYNOPSIS
    Creates the app registration the TenuVault desktop app signs in with.

.DESCRIPTION
    TenuVault Desktop uses an app registration that lives in your own tenant. It is a
    public client (no secret, no certificate) with delegated permissions only, so every
    call runs as the signed-in admin and is subject to your Conditional Access policies.

    The script:
      * creates a single-tenant public client app registration
      * adds the loopback redirect URI (system browser sign-in)
      * requests the delegated permissions TenuVault uses
      * grants tenant-wide admin consent for those permissions
      * optionally limits sign-in to members of one group

    The script needs no PowerShell modules and installs nothing. It opens your browser to
    sign in (through Microsoft Graph Command Line Tools, the Microsoft app that Microsoft
    Graph PowerShell also signs in through) and then calls Microsoft Graph directly. It
    waits up to 15 minutes for the sign-in.

    Sign in with a Global Administrator, Privileged Role Administrator or Cloud Application
    Administrator account, which can grant admin consent.

    If a step fails after the app registration was created, the script removes it again,
    so a failed run leaves nothing behind.

.PARAMETER TenantId
    Tenant to create the app registration in. Defaults to the tenant of the account you sign in with.

.PARAMETER DisplayName
    Name of the app registration. Default: "TenuVault Desktop".

.PARAMETER AllowedGroupId
    Object id of a security group. When set, only members of this group can sign in to TenuVault.
    Recommended: use a group of the admins who run TenuVault and make sure you are a member.
    Assigning a group needs Entra ID P1 or P2, and only direct members get access (nested
    groups do not). Off by default so an admin who is not in the group is not locked out.

.PARAMETER IncludeGroupRead
    When set, also requests the delegated Group.Read.All permission. The hygiene
    unresolved groups check needs it to tell whether a referenced group exists. Without
    it that check stays unknown. Off by default, so the default permission set is unchanged.

.PARAMETER IncludeNotifications
    When set, also requests the delegated Mail.Send, GroupMember.Read.All and User.Read.All permissions.
    Notification email channels send as the signed-in admin and can resolve Entra group
    recipients. Without it, email channels fail with a Graph permission error while
    webhook and Teams channels keep working. Off by default.

.PARAMETER IncludeAuditLog
    When set, also requests the delegated AuditLog.Read.All permission, so notification
    change watching can read Conditional Access, named location and authentication strength
    changes from the Entra audit log. The signed-in admin also needs a role that can read
    audit logs, such as Security Reader, Global Reader or Reports Reader. Off by default.

.PARAMETER IncludeConditionalAccessRestore
    When set, also requests the delegated Policy.ReadWrite.ConditionalAccess permission, so
    TenuVault can restore Entra Conditional Access policies, named locations and authentication
    strengths. Backing them up only needs Policy.Read.All, which is always requested. A restore
    still needs an admin with the Conditional Access Administrator or Security Administrator
    role, and restored policies start in report-only mode. Off by default, so the default
    permission set cannot change Conditional Access.

.PARAMETER UseDeviceCode
    Signs in with a device code instead of opening a browser on this computer: the script
    prints an address and a code that you enter in a browser on any device. For remote
    shells without a browser. Conditional Access often blocks device code flow, so only
    use it when the browser sign-in is not possible.

.EXAMPLE
    ./New-TenuVaultDesktopApp.ps1

.EXAMPLE
    ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -AllowedGroupId 5f0c...

.EXAMPLE
    ./New-TenuVaultDesktopApp.ps1 -UseDeviceCode

.EXAMPLE
    ./New-TenuVaultDesktopApp.ps1 -TenantId contoso.onmicrosoft.com -IncludeGroupRead
#>
[CmdletBinding()]
param(
    [string]$TenantId,
    [string]$DisplayName = "TenuVault Desktop",
    [string]$AllowedGroupId,
    [switch]$IncludeGroupRead,
    [switch]$IncludeNotifications,
    [switch]$IncludeAuditLog,
    [switch]$IncludeConditionalAccessRestore,
    [switch]$UseDeviceCode
)

$ErrorActionPreference = "Stop"
# Any failure ends the script with one readable message instead of an excerpt of this file.
trap {
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { break }
    $PSCmdlet.ThrowTerminatingError((New-Object Management.Automation.ErrorRecord ([Exception]$_.Exception.Message), 'TenuVaultSetupFailed', ([Management.Automation.ErrorCategory]::NotSpecified), $null))
}
$manualGuide = 'https://docs.tenuvault.com/getting-started/app-registration/#create-the-app-registration-manually'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw "This PowerShell session runs in $($ExecutionContext.SessionState.LanguageMode) mode, which blocks the browser sign-in this script uses. Create the app registration by hand instead: $manualGuide"
}
if ($AllowedGroupId) {
    $groupGuid = [Guid]::Empty
    if (-not [Guid]::TryParse($AllowedGroupId, [ref]$groupGuid)) { throw "-AllowedGroupId must be the object ID of a group, a GUID. Nothing was changed." }
}
# Windows PowerShell 5.1 does not offer TLS 1.2 by default on older systems.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# Behind a proxy that asks for the Windows sign-in, answer with the current user (5.1, then 7).
try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }
try { [Net.Http.HttpClient]::DefaultProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }

# Both PowerShell editions expose HTTP error bodies, but in different places.
function Get-HttpFailure($Record) {
    $body = $Record.ErrorDetails.Message
    $response = $Record.Exception.Response
    if (-not $body -and $response) {
        try {
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } catch { }
    }
    $detail = $null
    try { $detail = $body | ConvertFrom-Json } catch { }
    $status = 0
    $retryAfter = 0
    if ($response) {
        $status = [int]$response.StatusCode
        try { $retryAfter = [int]($response.Headers['Retry-After'] | Select-Object -First 1) } catch { }
        if (-not $retryAfter) {
            try { $retryAfter = [int]$response.Headers.RetryAfter.Delta.TotalSeconds } catch { }
        }
        if (-not $retryAfter) {
            try { $retryAfter = [int][Math]::Ceiling(($response.Headers.RetryAfter.Date - [DateTimeOffset]::UtcNow).TotalSeconds) } catch { }
        }
        if (-not $retryAfter) {
            try { $retryAfter = [int][Math]::Ceiling(([DateTimeOffset]::Parse($response.Headers['Retry-After']) - [DateTimeOffset]::UtcNow).TotalSeconds) } catch { }
        }
    }
    $message = $Record.Exception.Message
    $code = ''
    if ($detail.error_description) { $message = $detail.error_description; $code = $detail.error }
    elseif ($detail.error.message) { $message = $detail.error.message; $code = $detail.error.code }
    elseif ($detail.error) { $code = [string]$detail.error }
    [pscustomobject]@{ Status = $status; Code = $code; Message = $message; RetryAfter = $retryAfter }
}
function ConvertTo-Base64Url([byte[]]$Bytes) {
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function New-RandomToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    ConvertTo-Base64Url $bytes
}
# The page the browser shows when the sign-in comes back to this computer.
function Send-BrowserResponse($Response, [string]$Title, [string]$Message) {
    $style = 'body{font-family:Segoe UI,system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:34rem;margin:1rem;padding:2rem;background:#fff;border-radius:1rem;box-shadow:0 1px 3px rgba(15,23,42,.15)}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;line-height:1.5;overflow-wrap:anywhere}'
    $html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TenuVault setup</title><style>' + $style + '</style></head><body><main><h1>' + [Net.WebUtility]::HtmlEncode($Title) + '</h1><p>' + [Net.WebUtility]::HtmlEncode($Message) + '</p></main></body></html>'
    $bytes = [Text.Encoding]::UTF8.GetBytes($html)
    $Response.ContentType = 'text/html; charset=utf-8'
    $Response.ContentLength64 = $bytes.Length
    try { $Response.OutputStream.Write($bytes, 0, $bytes.Length); $Response.OutputStream.Flush() }
    finally { $Response.Close() }
}
$clientId = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
$authorityTenant = 'organizations'
if ($TenantId) { $authorityTenant = [uri]::EscapeDataString($TenantId) }
$authority = "https://login.microsoftonline.com/$authorityTenant/oauth2/v2.0"
$scope = 'https://graph.microsoft.com/Application.ReadWrite.All https://graph.microsoft.com/DelegatedPermissionGrant.ReadWrite.All openid profile'
if ($AllowedGroupId) { $scope += ' https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All' }
Write-Host ''
Write-Host "Creating the app registration '$DisplayName' that TenuVault Desktop signs in with."
Write-Host 'Sign in with an account that is Global Administrator, Privileged Role Administrator or'
Write-Host 'Cloud Application Administrator. Nothing is installed on this computer.'
Write-Host ''
if ($UseDeviceCode) {
    try { $device = Invoke-RestMethod -Method Post -Uri "$authority/devicecode" -Body @{ client_id = $clientId; scope = $scope } }
    catch { $failure = Get-HttpFailure $_; throw "Could not start device code sign-in. Nothing was changed. $($failure.Message)" }
    Write-Host "To sign in, open $($device.verification_uri) in a browser on any device and enter the code $($device.user_code)"
    Write-Host 'Waiting for you to sign in (Ctrl+C cancels)...'
    $deadline = [DateTime]::UtcNow.AddSeconds($device.expires_in)
    $interval = [Math]::Max(1, [int]$device.interval)
    $token = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds $interval
        try {
            $token = Invoke-RestMethod -Method Post -Uri "$authority/token" -Body @{ grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; client_id = $clientId; device_code = $device.device_code }
            break
        } catch {
            $failure = Get-HttpFailure $_
            switch ($failure.Code) {
                'authorization_pending' { continue }
                'slow_down' { $interval += 5; continue }
                'authorization_declined' { throw 'Device code sign-in was declined. Nothing was changed.' }
                'expired_token' { throw 'Device code expired. Nothing was changed. Run the script again.' }
                default { throw "Device code sign-in failed. Conditional Access may block device code flow. $($failure.Message)" }
            }
        }
    }
    if (-not $token) { throw 'Device code expired. Nothing was changed. Run the script again.' }
} else {
    $listener = $null
    try {
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            $probe = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
            $probe.Start()
            $port = $probe.LocalEndpoint.Port
            $probe.Stop()
            $listener = New-Object Net.HttpListener
            $listener.Prefixes.Add("http://localhost:$port/")
            try { $listener.Start(); break } catch { $listener.Close(); $listener = $null }
        }
        if (-not $listener) { throw 'Could not start browser sign-in. Try -UseDeviceCode or the manual app registration guide.' }
        $redirectUri = "http://localhost:$port"
        $state = New-RandomToken
        $verifier = New-RandomToken
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $challenge = ConvertTo-Base64Url ($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier))) } finally { $sha.Dispose() }
        $query = [ordered]@{ client_id = $clientId; response_type = 'code'; redirect_uri = $redirectUri; response_mode = 'query'; scope = $scope; state = $state; code_challenge = $challenge; code_challenge_method = 'S256'; prompt = 'select_account' }
        $parts = foreach ($key in $query.Keys) { [uri]::EscapeDataString($key) + '=' + [uri]::EscapeDataString($query[$key]) }
        $url = "$authority/authorize?" + ($parts -join '&')
        Write-Host 'Your browser opens now. Choose your admin account there.'
        Write-Host ''
        Write-Host 'If it does not open, or you need another browser or browser profile, open this address by hand:'
        Write-Host $url
        Write-Host ''
        Write-Host 'Waiting for you to sign in (up to 15 minutes, Ctrl+C cancels)...'
        try { Start-Process $url } catch { Write-Host 'The browser did not open. Open the address above by hand, or run with -UseDeviceCode.' }
        $deadline = [DateTime]::UtcNow.AddMinutes(15)
        $pending = $listener.GetContextAsync()
        $code = $null
        while ([DateTime]::UtcNow -lt $deadline) {
            if (-not $pending.IsCompleted) { Start-Sleep -Milliseconds 100; continue }
            $answer = $pending.GetAwaiter().GetResult()
            $values = $answer.Request.QueryString
            if ($values['state'] -cne $state -or (-not $values['code'] -and -not $values['error'])) {
                Send-BrowserResponse $answer.Response 'TenuVault setup' 'Waiting for the sign-in answer.'
                $pending = $listener.GetContextAsync()
                continue
            }
            if ($values['error']) {
                $message = $values['error_description']
                if (-not $message) { $message = $values['error'] }
                Send-BrowserResponse $answer.Response 'Sign-in did not work' "$message Go back to PowerShell and run the script again."
                throw "Browser sign-in failed. Nothing was changed. $message"
            }
            $code = $values['code']
            Send-BrowserResponse $answer.Response 'You are signed in' 'Go back to PowerShell, where the setup continues. You can close this tab.'
            break
        }
        if (-not $code) { throw 'Sign-in was not completed within 15 minutes. Nothing was changed. Run the script again.' }
    } finally {
        if ($listener) { $listener.Stop(); $listener.Close() }
    }
    try {
        $token = Invoke-RestMethod -Method Post -Uri "$authority/token" -Body @{ grant_type = 'authorization_code'; client_id = $clientId; code = $code; redirect_uri = $redirectUri; code_verifier = $verifier }
    } catch { $failure = Get-HttpFailure $_; throw "Microsoft did not accept the sign-in. Nothing was changed. $($failure.Message)" }
}
if (-not $token.access_token -or -not $token.id_token) { throw 'Sign-in did not return the tenant, user name and access token. Nothing was changed.' }
$payload = $token.id_token.Split('.')[1].Replace('-', '+').Replace('_', '/')
$payload = $payload.PadRight($payload.Length + ((4 - $payload.Length % 4) % 4), '=')
$identity = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
$username = $identity.preferred_username
if (-not $username) { $username = $identity.upn }
if (-not $username) { $username = $identity.email }
if (-not $identity.tid -or -not $username -or -not $token.access_token) { throw 'Sign-in did not return the tenant, user name and access token. Nothing was changed.' }
$context = @{ TenantId = $identity.tid }
Write-Host "Signed in as $username (tenant $($context.TenantId))."

function Invoke-Graph([string]$Method, [string]$Path, $Body, [switch]$ReplicationRetry) {
    $parameters = @{ Method = $Method; Uri = "https://graph.microsoft.com/v1.0$Path"; Headers = @{ Authorization = "Bearer $($token.access_token)" } }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json; charset=utf-8'
        $parameters.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20))
    }
    # A new object takes a few seconds to reach every Microsoft Graph replica, so calls that
    # refer to one are retried for about half a minute.
    $attempts = 4
    if ($ReplicationRetry) { $attempts = 12 }
    for ($attempt = 1; ; $attempt++) {
        try {
            return Invoke-RestMethod @parameters
        } catch {
            $failure = Get-HttpFailure $_
            $notThereYet = $ReplicationRetry -and ($failure.Status -eq 404 -or ($failure.Status -eq 400 -and $failure.Message -match 'valid application object|does not exist|not found|not present'))
            # A failed write is only repeated when repeating it cannot create a second object.
            $busy = $failure.Status -eq 429 -or ($failure.Status -ge 500 -and ($Method -eq 'GET' -or $ReplicationRetry))
            if ($attempt -lt $attempts -and ($notThereYet -or $busy)) {
                Start-Sleep -Seconds ([Math]::Min(60, [Math]::Max(3, $failure.RetryAfter)))
                continue
            }
            if ($failure.Status -eq 403 -or $failure.Code -eq 'Authorization_RequestDenied') {
                throw "The signed-in account $username lacks a role that can create app registrations and grant admin consent. Use a Global Administrator, Privileged Role Administrator or Cloud Application Administrator (with consent rights). $($failure.Message)"
            }
            throw "Graph $Method $Path failed: $($failure.Message)"
        }
    }
}
function Get-GraphItems([string]$Path) {
    do {
        $page = Invoke-Graph GET $Path
        $page.value
        $Path = $null
        if ($page.'@odata.nextLink') {
            $next = [uri]$page.'@odata.nextLink'
            if ($next.Host -ne 'graph.microsoft.com' -or $next.Scheme -ne 'https') { throw 'Unexpected Graph paging address.' }
            $Path = $next.PathAndQuery -replace '^/v1.0', ''
        }
    } while ($Path)
}

# Delegated permissions per resource. TenuVault only uses what is listed here.
$resources = @(
    @{
        Name   = "Microsoft Graph"
        AppId  = "00000003-0000-0000-c000-000000000000"
        Scopes = @(
            "User.Read",
            "Organization.Read.All",
            "Policy.Read.All",
            "DeviceManagementConfiguration.ReadWrite.All",
            "DeviceManagementApps.ReadWrite.All",
            "DeviceManagementServiceConfig.ReadWrite.All",
            "DeviceManagementScripts.ReadWrite.All",
            "DeviceManagementRBAC.ReadWrite.All",
            "DeviceManagementManagedDevices.Read.All"
        )
    },
    @{
        # Lists subscriptions and storage accounts in the backup storage picker.
        Name   = "Azure Service Management"
        AppId  = "797f4846-ba00-4fd7-ba43-dac1f8f63013"
        Scopes = @("user_impersonation")
    },
    @{
        # Backup storage account (blob data plane).
        Name   = "Azure Storage"
        AppId  = "e406a681-f3d4-42a8-90b6-c2b029497af1"
        Scopes = @("user_impersonation")
    }
)

if ($IncludeGroupRead) {
    # Opt-in only: lets the hygiene unresolved groups check read group existence.
    $resources[0].Scopes += "Group.Read.All"
}

if ($IncludeConditionalAccessRestore) {
    # Opt-in only: restores Conditional Access. Microsoft Graph also needs Policy.Read.All for these writes.
    $resources[0].Scopes += "Policy.ReadWrite.ConditionalAccess"
}

if ($IncludeAuditLog) {
    # Opt-in only: Conditional Access change watching reads the Entra audit log.
    $resources[0].Scopes += "AuditLog.Read.All"
}

if ($IncludeNotifications) {
    # Opt-in only: notification email as the signed-in admin, plus group recipient resolution.
    $resources[0].Scopes += "Mail.Send"
    $resources[0].Scopes += "GroupMember.Read.All"
    # Reading other members' mail and userType needs their basic profile properties.
    $resources[0].Scopes += "User.Read.All"
}

$requiredResourceAccess = @()
foreach ($resource in $resources) {
    $filter = [uri]::EscapeDataString("appId eq '$($resource.AppId)'")
    $sp = Get-GraphItems "/servicePrincipals?`$filter=$filter"
    if (-not $sp) {
        Write-Host "Adding the $($resource.Name) service principal to the tenant..."
        $sp = Invoke-Graph POST '/servicePrincipals' @{ appId = $resource.AppId } -ReplicationRetry
    }
    $resource.ServicePrincipalId = $sp.id
    $access = foreach ($scopeName in $resource.Scopes) {
        $permission = $sp.oauth2PermissionScopes | Where-Object Value -eq $scopeName
        if (-not $permission) { throw "Delegated permission $scopeName was not found on $($resource.Name)." }
        @{ id = $permission.id; type = 'Scope' }
    }
    $requiredResourceAccess += @{ resourceAppId = $resource.AppId; resourceAccess = @($access) }
}
$filter = [uri]::EscapeDataString("displayName eq '$($DisplayName.Replace("'", "''"))'")
foreach ($existing in (Get-GraphItems "/applications?`$filter=$filter")) {
    Write-Host "An app registration named '$DisplayName' already exists (client id $($existing.appId)). This run creates another one. Delete the unused registration." -ForegroundColor Yellow
}
$app = $null
try {
    Write-Host "Creating app registration '$DisplayName'..."
    $app = Invoke-Graph POST '/applications' @{
        displayName = $DisplayName
        signInAudience = 'AzureADMyOrg'
        requiredResourceAccess = $requiredResourceAccess
        notes = 'Used by the TenuVault desktop app. Delegated permissions only, no credentials.'
        publicClient = @{ redirectUris = @('http://localhost') }
    }
    $appSp = Invoke-Graph POST '/servicePrincipals' @{ appId = $app.appId; tags = @('HideApp', 'WindowsAzureActiveDirectoryIntegratedApp') } -ReplicationRetry
    Write-Host "Granting admin consent for these delegated permissions..."
    foreach ($resource in $resources) {
        Write-Host "  $($resource.Name): $($resource.Scopes -join ', ')"
        Invoke-Graph POST '/oauth2PermissionGrants' @{ clientId = $appSp.id; consentType = 'AllPrincipals'; resourceId = $resource.ServicePrincipalId; scope = ($resource.Scopes -join ' ') } -ReplicationRetry | Out-Null
    }
    if ($AllowedGroupId) {
        Write-Host "Limiting sign-in to members of group $AllowedGroupId..."
        Invoke-Graph PATCH "/servicePrincipals/$($appSp.id)" @{ appRoleAssignmentRequired = $true } | Out-Null
        Invoke-Graph POST "/servicePrincipals/$($appSp.id)/appRoleAssignedTo" @{ principalId = $AllowedGroupId; resourceId = $appSp.id; appRoleId = [Guid]::Empty.ToString() } -ReplicationRetry | Out-Null
    }
} catch {
    $reason = $_.Exception.Message
    if ($app) {
        try { Invoke-Graph DELETE "/applications/$($app.id)" -ReplicationRetry | Out-Null }
        catch { throw "Setup did not finish. Delete app registration '$DisplayName' (client id $($app.appId)) in the Entra admin center. Cleanup failed: $($_.Exception.Message) Original failure: $reason" }
        throw "Setup did not finish. The half-created app registration was removed, so nothing was left behind. $reason"
    }
    throw "Setup did not finish. $reason"
}

Write-Host ""
Write-Host "Done. Copy the two lines below and paste them into the Sign in step of Set up TenuVault:" -ForegroundColor Green
Write-Host "  Tenant id:                $($context.TenantId)"
Write-Host "  Application (client) id:  $($app.AppId)"
try {
    if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
        Set-Clipboard -Value ("  Tenant id:                $($context.TenantId)", "  Application (client) id:  $($app.AppId)" -join [Environment]::NewLine)
        Write-Host "Both lines are on your clipboard. TenuVault fills them in when you return to the Sign in step."
    }
} catch { }
Write-Host ""
Write-Host "The admins who use TenuVault also need an Intune role (for example Intune Administrator)."
Write-Host "For backups, schedules and the audit log in an Azure storage account they also need 'Storage"
Write-Host "Blob Data Contributor' and read access on that account (see New-TenuVaultStorage.ps1)."
if (-not $AllowedGroupId) {
    Write-Host ""
    Write-Host "Recommended: any user in the tenant can sign in to this app registration. To limit sign-in to" -ForegroundColor Yellow
    Write-Host "your admins, add them to a security group, then in Entra ID > Enterprise applications >" -ForegroundColor Yellow
    Write-Host "'$DisplayName' assign the group and set 'Assignment required' to Yes. Add yourself to the" -ForegroundColor Yellow
    Write-Host "group first so you do not lock yourself out. Group assignment needs Entra ID P1 or P2, and only" -ForegroundColor Yellow
    Write-Host "direct members get access (nested groups do not). New registrations can use -AllowedGroupId instead." -ForegroundColor Yellow
}
