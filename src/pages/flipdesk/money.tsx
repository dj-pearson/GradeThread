import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Wallet } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { PageHostContext } from "@/hooks/use-page-host";
import { HostViewSkeleton } from "@/components/flipdesk/host-view-skeleton";
import {
  MONEY_VIEW_GROUPS,
  MONEY_VIEW_LABELS,
  resolveMoneyView,
} from "@/pages/flipdesk/nav-tabs";
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
const MoneyOverviewPage = lazy(() =>
  import("@/pages/flipdesk/money-overview").then((m) => ({
    default: m.MoneyOverviewPage,
  }))
);
const DeductionsPage = lazy(() =>
  import("@/pages/flipdesk/deductions").then((m) => ({
    default: m.DeductionsPage,
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
          {/* US-2999. THE STRIP IS GROUPED, and on a phone it is not a strip
              at all.

              Seven equal tabs in one row is what this hub would have become,
              and it is unreadable twice over: on a laptop it reads as seven
              peers when three of them are a March job, and on a phone it is a
              horizontal scroll where the tab you want is off-screen with no
              sign it exists. AC5 asks for a designed mobile layout, and a
              scrolling tab row is the inherited one.

              So: a labelled two-tier strip from `sm:` up, and a native picker
              below it. Both read MONEY_VIEW_GROUPS, so neither can drift. */}
          <div className="sm:hidden">
            <Label htmlFor="money-view" className="sr-only">
              Which part of Money
            </Label>
            <Select value={activeView} onValueChange={setActiveView}>
              <SelectTrigger id="money-view" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONEY_VIEW_GROUPS.map((group) => (
                  <SelectGroup key={group.label ?? "top"}>
                    {group.label && <SelectLabel>{group.label}</SelectLabel>}
                    {group.views.map((v) => (
                      <SelectItem key={v} value={v}>
                        {MONEY_VIEW_LABELS[v]}
                        {v === "pnl" && reviewCount > 0 ? ` (${reviewCount})` : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="hidden flex-wrap items-center gap-x-5 gap-y-2 sm:flex">
            {MONEY_VIEW_GROUPS.map((group) => (
              <div key={group.label ?? "top"} className="flex items-center gap-2">
                {group.label && (
                  <span className="text-[13px] text-muted-foreground">
                    {group.label}
                  </span>
                )}
                <TabsList>
                  {group.views.map((v) => (
                    <TabsTrigger key={v} value={v}>
                      {MONEY_VIEW_LABELS[v]}
                      {v === "pnl" && reviewCount > 0 && (
                        <span
                          className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
                          aria-label={`${reviewCount} thing${reviewCount === 1 ? "" : "s"} in your books need a look`}
                        >
                          {reviewCount}
                        </span>
                      )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            ))}
          </div>

          {/* Only the active view mounts — each page runs its own queries, and
              mounting all three would fire every one of them on arrival. */}
          <TabsContent value="overview" className="mt-6">
            {activeView === "overview" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <MoneyOverviewPage />
              </Suspense>
            )}
          </TabsContent>
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
          <TabsContent value="deductions" className="mt-6">
            {activeView === "deductions" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <DeductionsPage />
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
