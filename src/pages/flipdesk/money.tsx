import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Wallet } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { PageHostContext } from "@/hooks/use-page-host";
import { HostViewSkeleton } from "@/components/flipdesk/host-view-skeleton";
import { resolveMoneyView } from "@/pages/flipdesk/nav-tabs";
import { PageHelp } from "@/components/help/page-help";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { fetchReviewCount } from "@/lib/books-review";

// US-2161: Finances, Expenses and Reconcile were three sidebar entries
// answering one question — where did my money go. They are one destination
// now, with ?view= carrying the choice.
//
// Same shape as the Pricing and Sourcing hosts, with one deliberate
// difference: the parameter is `?view=`, not `?tab=`. Reconcile already owns
// `?tab=` for its own four inner tabs (Photos→Items, eBay SKU match, Payouts &
// fees, Cross-source — US-963). Reusing `tab` here would have forced a choice
// between renaming those values, which breaks every bookmark and every in-app
// link carrying one, and two levels quietly fighting over the same key. With a
// distinct outer parameter, `?view=reconcile&tab=payouts` resolves both levels
// independently and every existing Reconcile deep link survives untouched.
//
// US-2548: the host names itself now. It used to render no PageHeader at all,
// so the screen read: app chrome, an unlabelled row of tabs, then "Finances" —
// and "Money", the destination the sidebar sent you to, appeared nowhere on
// the page. The three views keep every action they own; PageHeader drops only
// their titles when it sees PageHostContext.embedded, which is the mechanism
// the Account hub has used since US-1441.
//
// Each page is lazy, so opening Money pulls one view's bundle rather than
// three. Finances in particular carries its own charts.

const FinancesPage = lazy(() =>
  import("@/pages/finances").then((m) => ({ default: m.FinancesPage }))
);
const PnlPage = lazy(() =>
  import("@/pages/flipdesk/pnl").then((m) => ({ default: m.PnlPage }))
);
const ExpensesPage = lazy(() =>
  import("@/pages/flipdesk/expenses").then((m) => ({
    default: m.FlipdeskExpensesPage,
  }))
);
const ReconcilePage = lazy(() =>
  import("@/pages/flipdesk/reconcile").then((m) => ({
    default: m.FlipdeskReconcilePage,
  }))
);
const TaxSetupPage = lazy(() =>
  import("@/pages/flipdesk/tax-setup").then((m) => ({
    default: m.TaxSetupPage,
  }))
);

export function FlipdeskMoneyPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = resolveMoneyView(searchParams.get("view"));
  const user = useAuthStore((s) => s.user);

  // US-2992 AC5: the count is on the tab strip, so it is seen on arrival rather
  // than found. Scoped to the CURRENT calendar year -- a badge counting every
  // issue since the account opened is a number nobody can ever clear, and a
  // badge that never reaches zero stops being read.
  const year = new Date().getFullYear();
  const { data: reviewCount = 0 } = useQuery({
    queryKey: ["books-review-count", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchReviewCount(`${year}-01-01`, `${year + 1}-01-01`),
    staleTime: 5 * 60 * 1000,
  });

  function setActiveView(value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("view", value);
        // Reconcile's inner ?tab= belongs to Reconcile. Carrying it onto
        // Finances or Expenses would leave a stale key on the URL that means
        // nothing there and then reappears if the seller tabs back — so it is
        // dropped on the way out and Reconcile falls back to its own default.
        if (value !== "reconcile") next.delete("tab");
        return next;
      },
      // replace, not push: flipping views shouldn't fill the back button with
      // steps the seller has to walk out of to leave the page.
      { replace: true },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Wallet}
        title="Money"
        subtitle="Where it came from, where it went, and what it left you."
              actions={<PageHelp slug="reading-your-money" />}
      />
      <PageHostContext.Provider value={{ embedded: true }}>
        <Tabs value={activeView} onValueChange={setActiveView}>
          <TabsList>
            <TabsTrigger value="finances">Finances</TabsTrigger>
            <TabsTrigger value="pnl">
              P&amp;L
              {reviewCount > 0 && (
                <span
                  className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
                  aria-label={`${reviewCount} thing${reviewCount === 1 ? "" : "s"} in your books need a look`}
                >
                  {reviewCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="expenses">Expenses</TabsTrigger>
            <TabsTrigger value="reconcile">Reconcile</TabsTrigger>
            <TabsTrigger value="tax">Tax</TabsTrigger>
          </TabsList>

          {/* Only the active view mounts — each page runs its own queries, and
              mounting all three would fire every one of them on arrival. */}
          <TabsContent value="finances" className="mt-6">
            {activeView === "finances" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <FinancesPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="pnl" className="mt-6">
            {activeView === "pnl" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <PnlPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="expenses" className="mt-6">
            {activeView === "expenses" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <ExpensesPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="reconcile" className="mt-6">
            {activeView === "reconcile" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <ReconcilePage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="tax" className="mt-6">
            {activeView === "tax" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <TaxSetupPage />
              </Suspense>
            )}
          </TabsContent>
        </Tabs>
      </PageHostContext.Provider>
    </div>
  );
}
