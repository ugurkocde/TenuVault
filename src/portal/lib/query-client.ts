import { showFeaturePlanError } from "@desktop/lib/plan-dialog"
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => { showFeaturePlanError(error) } }),
  mutationCache: new MutationCache({ onError: (error) => { showFeaturePlanError(error) } }),
  defaultOptions: {
    queries: {
      // Stale time of 30 seconds
      staleTime: 30 * 1000,
      // Cache time of 5 minutes
      gcTime: 5 * 60 * 1000,
      // Retry failed requests up to 3 times
      retry: 3,
      // Retry delay increases exponentially
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      // Refetch on window focus
      refetchOnWindowFocus: false,
    },
  },
})