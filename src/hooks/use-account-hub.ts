import { createContext, useContext } from "react";

// Signals that a page is being rendered embedded inside the unified Account hub
// (US-741 / US-1441) rather than at its own standalone route. Child pages read
// this to suppress their own top-level PageHeader: the hub's tab label already
// names the section, so a per-page heading would duplicate it (and stack a
// second title under the hub's tab strip). The standalone routes still exist
// (`/dashboard/settings`, `/dashboard/billing`, …) and render with the default
// `embedded: false`, so their headers are unaffected.
export const AccountHubContext = createContext<{ embedded: boolean }>({
  embedded: false,
});

export function useAccountHub(): { embedded: boolean } {
  return useContext(AccountHubContext);
}
