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
    },
  },
});
