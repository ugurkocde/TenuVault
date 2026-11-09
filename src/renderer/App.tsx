import "./lib/appearance"
import { lazy, Suspense, useState, type ReactNode } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom"
import { BackupProgressProvider } from "~/contexts/BackupProgressContext"
import { TenantProvider } from "~/contexts/TenantContext"
import { queryClient } from "~/lib/query-client"
import { useTenants } from "~/contexts/TenantContext"
import { Button } from "~/components/ui/button"
import { DesktopLayout } from "./components/DesktopLayout"
import { ErrorBoundary, ErrorPanel } from "./components/ErrorBoundary"
import { ActivationScreen } from "./components/ActivationScreen"
import { PlanDialogs } from "./components/PlanDialogs"
import { DisclaimerHost } from "./components/DisclaimerHost"
import { ProxySignInHost } from "./components/ProxySignInHost"
import { isUnlicensed, LicenseProvider, useLicense } from "./lib/license"
import { WhatsNewProvider } from "./lib/whats-new"
import LicensePage from "./pages/LicensePage"
import { hasOnboardingDraft } from "./lib/onboarding-draft"

// Desktop pages.
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"))
const SettingsPage = lazy(() => import("./pages/SettingsPage"))
const OverviewPage = lazy(() => import("./pages/OverviewPage"))
const FrameworksPage = lazy(() => import("./pages/FrameworksPage"))
const HubPage = lazy(() => import("./pages/HubPage"))
const BaselinesPage = lazy(() => import("./pages/BaselinesPage"))
const OibPage = lazy(() => import("./pages/OibPage"))
const SyncPage = lazy(() => import("./pages/SyncPage"))

// Portal pages (src/portal/app/portal).
const DashboardPage = lazy(() => import("~/app/portal/dashboard/page"))
const TenantsPage = lazy(() => import("~/app/portal/tenants/page"))
const BackupPage = lazy(() => import("~/app/portal/backup/page"))
const DriftPage = lazy(() => import("~/app/portal/drift/page"))
const AuditPage = lazy(() => import("~/app/portal/audit/page"))

function Spinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-blue-600" />
    </div>
  )
}

/** Start page: the guided setup until a tenant is connected, then the all-tenants overview or the dashboard. */
function Home() {
  const tenants = useTenants()
  if (tenants.length === 0) return <Navigate to="/portal/onboarding" replace />
  return <Navigate to={tenants.length > 1 ? "/portal/overview" : "/portal/dashboard"} replace />
}

/**
 * The welcome screen on first run. Licensing itself is per tenant and enforced in the main
 * process (sign-in, token requests, local backups, scheduled backups), so the plan is shown in
 * the guided setup once the tenant is known. A setup already in progress skips the welcome.
 */
function LicenseGate({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useLicense()
  const tenants = useTenants()
  const [signingIn, setSigningIn] = useState(hasOnboardingDraft)
  if (!status) {
    if (error !== null) {
      return (
        <ErrorPanel title="Could not load license status" message={error}>
          <Button type="button" onClick={() => void refresh().catch(() => {})}>Retry</Button>
        </ErrorPanel>
      )
    }
    return <Spinner />
  }
  if (isUnlicensed(status) && tenants.length === 0 && !signingIn) {
    return (
      <ActivationScreen
        onSignIn={() => {
          location.hash = "#/portal/onboarding"
          setSigningIn(true)
        }}
      />
    )
  }
  return children
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ProxySignInHost />
      <LicenseProvider>
        <WhatsNewProvider>
        <TenantProvider>
          <BackupProgressProvider>
            <DisclaimerHost />
            <ErrorBoundary>
            <LicenseGate>
            <HashRouter>
              <Suspense fallback={<Spinner />}>
                <Routes>
                  <Route element={<DesktopLayout />}>
                    <Route path="/license" element={<LicensePage />} />
                    <Route path="/portal" element={<Outlet />}>
                      <Route index element={<Home />} />
                      <Route path="dashboard" element={<DashboardPage />} />
                      <Route path="tenants" element={<TenantsPage />} />
                      <Route path="backup" element={<BackupPage />} />
                      <Route path="drift" element={<DriftPage />} />
                      <Route path="sync" element={<SyncPage />} />
                      <Route path="audit" element={<AuditPage />} />
                      <Route path="onboarding" element={<OnboardingPage />} />
                      <Route path="settings" element={<SettingsPage />} />
                      <Route path="overview" element={<OverviewPage />} />
                      <Route path="frameworks" element={<FrameworksPage />} />
                      <Route path="frameworks/oib" element={<Navigate to="/portal/oib" replace />} />
                      <Route path="frameworks/:frameworkId" element={<FrameworksPage />} />
                      <Route path="baselines" element={<BaselinesPage />} />
                      <Route path="baselines/:baselineId" element={<BaselinesPage />} />
                      {["governance", "changes", "operations", "reports"].map((hub) => (
                        <Route key={hub} path={`${hub}/:tabId?`} element={<HubPage hubId={hub} />} />
                      ))}
                      <Route path="alerts/:tabId?" element={<HubPage hubId="alerts" />} />
                      <Route path="oib" element={<OibPage />} />
                      <Route path="oib/:flow" element={<OibPage />} />
                    </Route>
                  </Route>
                  <Route path="*" element={<Home />} />
                </Routes>
              </Suspense>
              <PlanDialogs />
            </HashRouter>
            </LicenseGate>
            </ErrorBoundary>
          </BackupProgressProvider>
        </TenantProvider>
        </WhatsNewProvider>
      </LicenseProvider>
    </QueryClientProvider>
  )
}
