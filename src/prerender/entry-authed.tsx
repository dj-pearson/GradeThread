/**
 * US-3013: render one AUTHED screen to static HTML, for the UI-layout harness.
 *
 * `entry-server.tsx` next door renders PUBLIC routes at build time and is
 * deliberately kept clear of the auth/dashboard/supabase graph. This one is the
 * opposite: it exists only so `scripts/check-ui-authed.mjs` can point
 * `impeccable detect` at a dashboard screen, which is most of the product and
 * which nothing has ever checked.
 *
 * ⚠ THIS IS NEVER BUILT AND NEVER SHIPPED. It is loaded through
 * `vite.ssrLoadModule` by the harness script, with `@tanstack/react-query`
 * aliased to [authed-query-stub] so a page takes its LOADED branch under
 * `renderToString`, which does not await. Nothing in `dist/` imports it.
 *
 * ADDING A SCREEN IS ONE LINE in [SCREENS]. The point of the registry is that
 * the cost of covering another view is a line, not a harness.
 */

import { StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { useAuthStore } from "@/stores/auth-store";
import { MoneyOverviewPage } from "@/pages/flipdesk/money-overview";
import { FlipdeskExpensesPage } from "@/pages/flipdesk/expenses";
import { FinancesPage } from "@/pages/finances";
import { FlipdeskReconcilePage } from "@/pages/flipdesk/reconcile";
import { PnlPage } from "@/pages/flipdesk/pnl";
import { DeductionsPage } from "@/pages/flipdesk/deductions";
import { TaxSetupPage } from "@/pages/flipdesk/tax-setup";

/**
 * One line per screen: a key for the CLI, the route it sits at, and the
 * component.
 *
 * All seven Money views (MONEY_VIEWS in @/pages/flipdesk/nav-tabs), which is
 * AC4. The HOST is deliberately absent: it renders its views through
 * React.lazy, and renderToStaticMarkup does not await, so scanning the host
 * would scan a Suspense fallback and call it a screen.
 */
export const SCREENS: {
  key: string;
  path: string;
  render: () => React.ReactNode;
}[] = [
  {
    key: "money",
    path: "/dashboard/flipdesk/money",
    render: () => <MoneyOverviewPage />,
  },
  {
    key: "finances",
    path: "/dashboard/flipdesk/money?view=finances",
    render: () => <FinancesPage />,
  },
  {
    key: "expenses",
    path: "/dashboard/flipdesk/money?view=expenses",
    render: () => <FlipdeskExpensesPage />,
  },
  // Reconcile's four inner tabs render one at a time, and ?tab= picks which -
  // so each tab is its own entry. The default "photos" tab is a drop zone fed
  // by local state, not by a query, so no fixture can fill it and it will
  // always render thin. The other three are worth more.
  {
    key: "reconcile",
    path: "/dashboard/flipdesk/money?view=reconcile",
    render: () => <FlipdeskReconcilePage />,
  },
  {
    key: "reconcile-payouts",
    path: "/dashboard/flipdesk/money?view=reconcile&tab=payouts",
    render: () => <FlipdeskReconcilePage />,
  },
  {
    key: "reconcile-ebay",
    path: "/dashboard/flipdesk/money?view=reconcile&tab=ebay",
    render: () => <FlipdeskReconcilePage />,
  },
  {
    key: "reconcile-conflicts",
    path: "/dashboard/flipdesk/money?view=reconcile&tab=cross-source",
    render: () => <FlipdeskReconcilePage />,
  },
  {
    key: "pnl",
    path: "/dashboard/flipdesk/money?view=pnl",
    render: () => <PnlPage />,
  },
  {
    key: "deductions",
    path: "/dashboard/flipdesk/money?view=deductions",
    render: () => <DeductionsPage />,
  },
  {
    key: "tax",
    path: "/dashboard/flipdesk/money?view=tax",
    render: () => <TaxSetupPage />,
  },
];

/**
 * A signed-in user, because half these pages gate their whole body on one.
 *
 * Set on the real Zustand store rather than mocked, since the store is plain
 * JavaScript with no browser in it. Nothing persists: this module is loaded
 * into a throwaway SSR process.
 */
function signIn() {
  useAuthStore.setState({
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "harness@example.invalid",
      created_at: "2026-01-01T00:00:00Z",
    } as never,
    session: { access_token: "harness" } as never,
    loading: false,
  } as never);
}

export function renderScreen(key: string): string {
  const screen = SCREENS.find((s) => s.key === key);
  if (!screen) throw new Error(`unknown screen: ${key}`);
  signIn();
  // retry:false so a fixture-less query cannot schedule work in a process that
  // is about to exit.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return renderToStaticMarkup(
    <StrictMode>
      <QueryClientProvider client={client}>
        <StaticRouter location={screen.path}>
          {/* The providers a dashboard screen assumes RootLayout put there.
              Add one here when a screen throws "must be used within" rather
              than dropping the screen - the throw is the app telling you what
              it needs, and a screen skipped is a screen unchecked. */}
          <ConfirmProvider>{screen.render()}</ConfirmProvider>
        </StaticRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
