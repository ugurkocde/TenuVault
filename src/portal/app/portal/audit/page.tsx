"use client"

import { useState, useEffect, useRef, Suspense } from "react"
import { useSelectedTenant } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { 
  Shield, 
  Download, 
  RefreshCw, 
  Search,
  Calendar,
  Filter,
  ChevronDown,
  Activity,
  AlertCircle,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  Database,
  GitCompare,
  Loader2
} from "lucide-react"
import { AuditLogEntry, AuditEventType, AuditSeverity, AuditResult, DESKTOP_AUDIT_EVENT_TYPES, DESKTOP_AUDIT_SEVERITIES } from "~/lib/audit/types"
import { canUse, GatedButton, LockedPreview } from "@desktop/components/PlanGate"
import { useTenantPlan } from "@desktop/lib/license"
import { toast } from "@desktop/lib/toast"
import { OWN_OPERATION_NOTICE } from "~/lib/audit/export"
import { useConfirm } from "~/components/ConfirmDialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu"
import { auditDateFilter, defaultAuditDateRange } from "~/lib/audit/date-range"

function CleanupButton({ plan, cleaning, loading, onCleanup }: { plan: ReturnType<typeof useTenantPlan>; cleaning: boolean; loading: boolean; onCleanup: () => void }) {
  const { confirm, confirmDialog } = useConfirm()
  return (
    <>
      {confirmDialog}
      <GatedButton feature="auditLog" plan={plan} variant="outline" size="lg" disabled={cleaning || loading} onClick={async () => {
        if (await confirm({ title: "Remove old operation history?", description: "Remove operation history entries older than 90 days from this tenant's storage? This cannot be undone.", confirmLabel: "Remove entries", destructive: true })) onCleanup()
      }}>
        {cleaning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
        Remove entries older than 90 days
      </GatedButton>
    </>
  )
}

function AuditPageContent() {
  const { selectedTenant } = useSelectedTenant()
  // The audit log is Pro and MSP; other plans see a preview and never call the audit routes.
  const plan = useTenantPlan(selectedTenant?.credentials?.tenantId)
  const allowed = canUse(plan, "auditLog")
  const [cleaning, setCleaning] = useState(false)
  const [pendingCount, setPendingCount] = useState<number | null>(0)
  const [pendingDurable, setPendingDurable] = useState(false)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [dateRange, setDateRange] = useState(defaultAuditDateRange)
  const dateFilter = auditDateFilter(dateRange)
  const [filters, setFilters] = useState({
    eventTypes: [] as AuditEventType[],
    severities: [] as AuditSeverity[],
    results: [] as AuditResult[],
  })
  const [showFilters, setShowFilters] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(new Date())
  // The page belongs to one query: any change to the tenant, dates, filters or applied
  // search starts again at page 1 without a separate reset that could race the fetch.
  const tenantKey = selectedTenant ? `${selectedTenant.id}:${selectedTenant.credentials?.tenantId ?? ""}:${selectedTenant.resources?.storageAccountName ?? ""}` : ""
  const [appliedSearch, setAppliedSearch] = useState("")
  const queryKey = JSON.stringify([tenantKey, dateRange, filters, appliedSearch])
  const [pageState, setPageState] = useState({ key: queryKey, page: 1 })
  const pagination = { page: pageState.key === queryKey ? pageState.page : 1, pageSize: 50 }
  const setPage = (page: number) => setPageState({ key: queryKey, page })
  // The logs route reads only as far as a page needs, so there is no total. One extra
  // entry per request tells whether a next page exists.
  const [hasMore, setHasMore] = useState(false)

  // Fetch audit logs
  const fetchLogs = async () => {
    if (!allowed) return
    if (!selectedTenant) {
      setError("No tenant selected")
      return
    }

    if (!selectedTenant.credentials?.tenantId || !selectedTenant.credentials?.appId || !selectedTenant.credentials?.clientSecret || !selectedTenant.resources?.storageAccountName) {
      setError("Selected tenant is missing required credentials or resources. Please reconfigure the tenant.")
      return
    }

    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/audit/logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: selectedTenant.credentials?.tenantId,
          appId: selectedTenant.credentials?.appId,
          clientSecret: selectedTenant.credentials?.clientSecret,
          storageAccountName: selectedTenant.resources?.storageAccountName,
          filter: {
            ...dateFilter,
            searchQuery: appliedSearch || undefined,
            eventTypes: filters.eventTypes.length > 0 ? filters.eventTypes : undefined,
            severities: filters.severities.length > 0 ? filters.severities : undefined,
            results: filters.results.length > 0 ? filters.results : undefined,
            limit: pagination.pageSize + 1,
            offset: (pagination.page - 1) * pagination.pageSize,
            sortBy: 'timestamp',
            sortOrder: 'desc'
          }
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        setPendingCount(typeof error.pendingCount === "number" ? error.pendingCount : null)
        setPendingDurable(error.pendingDurable === true)
        throw new Error(error.error || "Failed to fetch audit logs")
      }

      const data = await response.json()
      const entries: AuditLogEntry[] = data.data || []
      setLogs(entries.slice(0, pagination.pageSize))
      setHasMore(entries.length > pagination.pageSize)
      setPendingCount(data.pendingCount ?? 0)
      setPendingDurable(data.pendingDurable === true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  // Fetch stats
  const fetchStats = async () => {
    if (!selectedTenant || !allowed) return
    
    if (!selectedTenant.credentials?.tenantId || !selectedTenant.credentials?.appId || !selectedTenant.credentials?.clientSecret || !selectedTenant.resources?.storageAccountName) {
      return
    }

    try {
      const response = await fetch("/api/audit/stats", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: selectedTenant.credentials?.tenantId,
          appId: selectedTenant.credentials?.appId,
          clientSecret: selectedTenant.credentials?.clientSecret,
          storageAccountName: selectedTenant.resources?.storageAccountName,
          filter: {
            ...dateFilter,
          }
        }),
      })

      if (!response.ok) throw new Error("Audit statistics are unavailable. Retry when storage access is restored.")
      const data = await response.json()
      setStats(data.data)
      setStatsError(null)
    } catch (err) {
      setStats(null)
      setStatsError(err instanceof Error ? err.message : "Audit statistics are unavailable.")
    }
  }

  // Load logs for the current query and page. Keyed by the tenant's identity, not the
  // tenant object, so a background update (such as a finished backup) keeps the page.
  useEffect(() => {
    fetchLogs()
  }, [queryKey, pagination.page, allowed])

  useEffect(() => {
    fetchStats()
  }, [tenantKey, allowed, dateRange])

  // Auto-refresh every 30 seconds with the query and page shown at that moment.
  const refresh = useRef(() => {})
  refresh.current = () => {
    fetchLogs()
    fetchStats()
    setLastRefresh(new Date())
  }
  useEffect(() => {
    if (!autoRefresh || !tenantKey || !allowed) return

    const interval = setInterval(() => refresh.current(), 30000) // 30 seconds

    return () => clearInterval(interval)
  }, [autoRefresh, tenantKey, allowed])

  // Handle search: a new search starts at page 1; the same search again reloads.
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (searchQuery !== appliedSearch) setAppliedSearch(searchQuery)
    else if (pagination.page !== 1) setPage(1)
    else fetchLogs()
  }

  // Export logs
  const handleExport = async (format: 'json' | 'csv') => {
    if (!selectedTenant || !allowed) return

    try {
      const response = await fetch("/api/audit/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenantId: selectedTenant.credentials?.tenantId,
          appId: selectedTenant.credentials?.appId,
          clientSecret: selectedTenant.credentials?.clientSecret,
          storageAccountName: selectedTenant.resources?.storageAccountName,
          exportOptions: {
            format,
            filter: {
              ...dateFilter,
              searchQuery: searchQuery || undefined,
              eventTypes: filters.eventTypes.length > 0 ? filters.eventTypes : undefined,
              severities: filters.severities.length > 0 ? filters.severities : undefined,
              results: filters.results.length > 0 ? filters.results : undefined,
            },
            includeDetails: true
          }
        }),
      })

      if (!response.ok) {
        const failure = await response.json().catch(() => ({}))
        throw new Error(failure.error || "Export failed")
      }

      // Download the file
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = response.headers.get('content-disposition')?.split('filename=')[1]?.replace(/"/g, '') || `audit-logs.${format}`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Export failed", "error")
    }
  }

  // Removes entries older than 90 days from this tenant's storage. Pro and MSP; the main process checks the plan.
  const handleCleanup = async () => {
    if (!selectedTenant?.credentials || !selectedTenant.resources?.storageAccountName) return
    setCleaning(true)
    try {
      const response = await fetch("/api/audit/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: selectedTenant.credentials.tenantId,
          appId: selectedTenant.credentials.appId,
          clientSecret: selectedTenant.credentials.clientSecret,
          storageAccountName: selectedTenant.resources.storageAccountName,
          retentionDays: 90,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || "Cleanup failed")
      toast(typeof data.message === "string" ? data.message : "Entries older than 90 days were removed.", "success")
      fetchLogs()
      fetchStats()
    } catch (err) {
      toast(err instanceof Error ? err.message : "Cleanup failed", "error")
    } finally {
      setCleaning(false)
    }
  }

  // Get icon for event type
  const getEventIcon = (eventType: AuditEventType) => {
    if (eventType.includes('AUTH')) return <Shield className="w-4 h-4" />
    if (eventType.includes('BACKUP')) return <Database className="w-4 h-4" />
    if (eventType.includes('SCHEDULE')) return <Calendar className="w-4 h-4" />
    if (eventType.includes('POLICY')) return <GitCompare className="w-4 h-4" />
    if (eventType.includes('SECURITY')) return <AlertCircle className="w-4 h-4" />
    return <Activity className="w-4 h-4" />
  }

  // Get severity color
  const getSeverityColor = (severity: AuditSeverity) => {
    switch (severity) {
      case AuditSeverity.CRITICAL:
        return 'text-primary-foreground bg-primary'
      case AuditSeverity.ERROR:
        return 'text-red-700 bg-red-50'
      case AuditSeverity.WARNING:
        return 'text-amber-800 bg-amber-50'
      default:
        return 'text-blue-700 bg-blue-50'
    }
  }

  // Get result icon
  const getResultIcon = (result: AuditResult) => {
    switch (result) {
      case AuditResult.SUCCESS:
        return <CheckCircle2 className="w-4 h-4 text-green-600" />
      case AuditResult.FAILURE:
        return <XCircle className="w-4 h-4 text-red-600" />
      case AuditResult.PARTIAL:
        return <AlertTriangle className="w-4 h-4 text-amber-600" />
      default:
        return <Info className="w-4 h-4 text-gray-600" />
    }
  }

  if (!selectedTenant) {
    return (
      <div className="flex-1 p-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col items-center rounded-3xl bg-white px-6 py-16 text-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
              <Shield className="w-7 h-7 text-gray-500" />
            </div>
            <h3 className="text-xl font-medium tracking-tight text-gray-900 mb-2">No Tenant Selected</h3>
            <p className="text-gray-500">Please select a tenant to view audit logs</p>
          </div>
        </div>
      </div>
    )
  }

  if (plan !== null && !allowed) {
    return (
      <div className="flex-1 p-8">
        <div className="mx-auto max-w-7xl space-y-8">
          <div>
            <h1 className="text-4xl font-medium tracking-tight text-gray-900">Audit Log</h1>
            <p className="mt-2 max-w-3xl text-base text-gray-500">{OWN_OPERATION_NOTICE}</p>
          </div>
          <LockedPreview
            feature="auditLog"
            summary="A searchable history of the operations TenuVault runs for this tenant, kept in the tenant's own storage."
            points={[
              "Backups, restores, schedules, drift checks and policy changes run by this installation, with result and severity.",
              "Filters by date, event type, severity and result, with statistics for the selected period.",
              "CSV and JSON exports with tokens and secrets removed, and cleanup of entries older than 90 days.",
            ]}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-8">
      <div className="mx-auto max-w-7xl space-y-8">
        {pendingCount === null && <div role="alert" className="rounded-xl bg-amber-50 p-4 text-amber-900">Pending audit events could not be counted. Keep this installation and resolve the local storage error before continuing.</div>}
        {pendingCount !== null && pendingCount > 0 && <div role="alert" className="rounded-xl bg-amber-50 p-4 text-amber-900">{pendingCount} audit event(s) remain unsaved. {pendingDurable ? "They are kept encrypted on this device. Keep this installation until they are saved." : "They are held in memory for this session. Keep the app open until they are saved."} Refresh this history to retry up to 100 pending events.</div>}
        {statsError && <div role="alert" className="rounded-xl bg-amber-50 p-4 text-amber-900">{statsError}</div>}
        {/* Header */}
        <div>
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-4xl font-medium tracking-tight text-gray-900">Audit Log</h1>
              <p className="mt-2 max-w-3xl text-base text-gray-500">{OWN_OPERATION_NOTICE}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <CleanupButton plan={plan} cleaning={cleaning} loading={loading} onCleanup={() => void handleCleanup()} />
              {/* Auto-refresh toggle */}
              <div className="flex h-11 items-center gap-2 rounded-full border border-gray-200 bg-white px-4">
                <input
                  type="checkbox"
                  id="auto-refresh"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label htmlFor="auto-refresh" className="text-sm text-gray-600">
                  Auto-refresh
                </label>
                {autoRefresh && (
                  <span className="text-xs text-gray-500">
                    (Last: {lastRefresh.toLocaleTimeString()})
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  fetchLogs()
                  fetchStats()
                  setLastRefresh(new Date())
                }}
                disabled={loading}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="lg">
                    <Download className="w-4 h-4 mr-2" />
                    Export
                    <ChevronDown className="w-3 h-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onSelect={() => void handleExport('json')}>Export as JSON</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void handleExport('csv')}>Export as CSV</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Stats Summary */}
          {stats && (
            <div className="grid grid-cols-2 gap-4 mt-8">
              <div className="rounded-3xl bg-white p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Total Events</p>
                    <p className="mt-3 text-3xl font-medium tracking-tight text-gray-900">{stats.summary.totalEvents}</p>
                  </div>
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
                    <Activity className="w-4 h-4 text-gray-600" />
                  </span>
                </div>
              </div>
              <div className="rounded-3xl bg-white p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-gray-500">Success Rate</p>
                    <p className="mt-3 text-3xl font-medium tracking-tight text-green-700">{stats.summary.successRate}</p>
                  </div>
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-green-50">
                    <CheckCircle2 className="w-4 h-4 text-green-700" />
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Search and Filters */}
        <div>
          <div className="space-y-4">
            {/* Search Bar */}
            <form onSubmit={handleSearch} className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="search"
                  placeholder="Search by user, action, or resource..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-11 w-full rounded-full border border-gray-200 bg-white pl-11 pr-4 text-sm placeholder:text-gray-400 focus:outline-none focus:border-blue-500"
                />
              </div>
              <Button type="submit" size="lg" disabled={loading}>
                Search
              </Button>
            </form>

            {/* Date Range and Filter Toggle */}
            <div className="flex flex-wrap gap-2 items-center">
              <div className="flex h-9 items-center gap-2 rounded-full border border-gray-200 bg-white pl-4 pr-2">
                <label htmlFor="audit-from" className="text-xs text-gray-500">From:</label>
                <input
                  id="audit-from" type="date"
                  value={dateRange.startDate}
                  onChange={(e) => setDateRange(prev => ({ ...prev, startDate: e.target.value }))}
                  className="border-0 bg-transparent px-1 text-sm text-gray-900 focus:outline-none"
                />
              </div>
              <div className="flex h-9 items-center gap-2 rounded-full border border-gray-200 bg-white pl-4 pr-2">
                <label htmlFor="audit-to" className="text-xs text-gray-500">To:</label>
                <input
                  id="audit-to" type="date"
                  value={dateRange.endDate}
                  onChange={(e) => setDateRange(prev => ({ ...prev, endDate: e.target.value }))}
                  className="border-0 bg-transparent px-1 text-sm text-gray-900 focus:outline-none"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="w-4 h-4 mr-2" />
                Filters
                <ChevronDown className={`w-3 h-3 ml-1 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
              </Button>
            </div>

            {/* Advanced Filters */}
            {showFilters && (
              <div className="rounded-3xl bg-white p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-2 block">Event Type</label>
                  <select
                    multiple
                    className="w-full rounded-2xl border border-gray-200 p-2 text-sm"
                    onChange={(e) => {
                      const selected = Array.from(e.target.selectedOptions).map(o => o.value).filter(value => value !== "").map(value => value as AuditEventType)
                      setFilters(prev => ({ ...prev, eventTypes: selected }))
                    }}
                  >
                    <option value="">All Types</option>
                    {DESKTOP_AUDIT_EVENT_TYPES.map(type => (
                      <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-2 block">Severity</label>
                  <select
                    multiple
                    className="w-full rounded-2xl border border-gray-200 p-2 text-sm"
                    onChange={(e) => {
                      const selected = Array.from(e.target.selectedOptions).map(o => o.value).filter(value => value !== "").map(value => value as AuditSeverity)
                      setFilters(prev => ({ ...prev, severities: selected }))
                    }}
                  >
                    <option value="">All Severities</option>
                    {DESKTOP_AUDIT_SEVERITIES.map(severity => (
                      <option key={severity} value={severity}>{severity}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-2 block">Result</label>
                  <select
                    multiple
                    className="w-full rounded-2xl border border-gray-200 p-2 text-sm"
                    onChange={(e) => {
                      const selected = Array.from(e.target.selectedOptions).map(o => o.value).filter(value => value !== "").map(value => value as AuditResult)
                      setFilters(prev => ({ ...prev, results: selected }))
                    }}
                  >
                    <option value="">All Results</option>
                    {Object.values(AuditResult).map(result => (
                      <option key={result} value={result}>{result}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Logs Table/Cards */}
        <div className="rounded-3xl bg-white overflow-hidden">
          {loading ? (
            <div className="flex flex-col items-center p-12 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
                <RefreshCw className="w-6 h-6 text-gray-500 animate-spin" />
              </div>
              <p className="text-gray-500">Loading audit logs...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center p-12 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
                <AlertCircle className="w-6 h-6 text-red-600" />
              </div>
              <p className="text-red-600">{error}</p>
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center p-12 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
                <Shield className="w-6 h-6 text-gray-500" />
              </div>
              <p className="font-medium text-gray-900">No audit logs found</p>
              <p className="text-sm text-gray-400 mt-2">Adjust your filters or try a different search query</p>
            </div>
          ) : (
            <>
              {/* Desktop Table View */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full">
                <thead className="border-b border-gray-100">
                  <tr>
                    <th className="text-left px-6 py-4 text-xs font-medium text-gray-500">
                      Timestamp
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-medium text-gray-500">
                      Event
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-medium text-gray-500">
                      User
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-medium text-gray-500">
                      Action
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-medium text-gray-500">
                      Resource
                    </th>
                    <th className="text-left px-6 py-4 text-xs font-medium text-gray-500">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <div>
                          <div>{new Date(log.timestamp).toLocaleDateString()}</div>
                          <div className="text-xs text-gray-500">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {getEventIcon(log.eventType)}
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${getSeverityColor(log.severity)}`}>
                            {log.severity}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <div>
                          <div className="font-medium text-gray-900">{log.user.name}</div>
                          <div className="text-xs text-gray-500">{log.user.email}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        {log.action}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <div>
                          <div className="font-medium">{log.resource.name}</div>
                          <div className="text-xs text-gray-500">{log.resource.type}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {getResultIcon(log.result)}
                          <span className="text-sm">{log.result}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>

              {/* Mobile Card View */}
              <div className="block lg:hidden">
                <div className="divide-y divide-gray-100">
                  {logs.map((log) => (
                    <div key={log.id} className="p-4 hover:bg-gray-50">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {getEventIcon(log.eventType)}
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${getSeverityColor(log.severity)}`}>
                            {log.severity}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div>
                          <p className="font-medium text-sm text-gray-900">{log.action}</p>
                          <p className="text-xs text-gray-600 mt-0.5">
                            {log.resource.type}: {log.resource.name}
                          </p>
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-xs font-medium text-gray-700">{log.user.name}</p>
                            <p className="text-xs text-gray-500">{log.user.email}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            {getResultIcon(log.result)}
                            <span className="text-xs text-gray-600">{log.result}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              {/* Pagination */}
              {logs.length > 0 && (
                <div className="flex flex-col sm:flex-row items-center justify-between px-4 sm:px-6 py-4 border-t border-gray-100 gap-4">
                  <div className="text-xs sm:text-sm text-gray-700 text-center sm:text-left">
                    Showing {((pagination.page - 1) * pagination.pageSize) + 1} to{' '}
                    {(pagination.page - 1) * pagination.pageSize + logs.length}
                    {hasMore ? ', more available' : ` of ${(pagination.page - 1) * pagination.pageSize + logs.length} entries`}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(Math.max(1, pagination.page - 1))}
                      disabled={pagination.page === 1 || loading}
                      className="text-xs sm:text-sm"
                    >
                      <span className="hidden sm:inline">Previous</span>
                      <span className="sm:hidden">Prev</span>
                    </Button>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="1"
                        value={pagination.page}
                        onChange={(e) => {
                          const page = parseInt(e.target.value) || 1
                          setPage(Math.max(1, page))
                        }}
                        className="h-8 w-12 sm:w-16 px-1 sm:px-2 text-center border border-gray-200 rounded-full text-xs sm:text-sm"
                      />
                      {!hasMore && (
                        <span className="text-xs sm:text-sm text-gray-600">
                          of {pagination.page}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(pagination.page + 1)}
                      disabled={!hasMore || loading}
                      className="text-xs sm:text-sm"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AuditPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    }>
      <AuditPageContent />
    </Suspense>
  )
}
