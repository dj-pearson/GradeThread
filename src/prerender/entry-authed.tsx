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

/**
 * One line per screen: a key for the CLI, the route it sits at, and the
 * component.
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
    key: "expenses",
    path: "/dashboard/flipdesk/money?view=expenses",
    render: () => <FlipdeskExpensesPage />,
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
