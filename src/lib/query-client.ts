import { QueryClient } from "@tanstack/react-query";

// The single app-wide TanStack Query client. Extracted from main.tsx so
// non-component modules (e.g. the auth bootstrap in use-auth.ts) can reach it —
// specifically to `queryClient.clear()` on sign-out so a shared browser never
// serves the previous user's cached finances/submissions/disputes to the next
// person who signs in (US-1617 / C4).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
      // US-1937: don't refetch every query on window/tab refocus. On a
      // data-heavy dashboard/admin tab this fired a burst of network requests
      // on each refocus for any query older than staleTime. Nothing relies on
      // focus-refetch — queries that need periodic freshness use an explicit
      // `refetchInterval` (polling), which is unaffected. A query that ever
      // genuinely needs focus-refetch can opt back in with
      // `refetchOnWindowFocus: true`.
      refetchOnWindowFocus: false,
    },
  },
});
