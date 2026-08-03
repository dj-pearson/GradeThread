import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resolveMoneyView } from "@/pages/flipdesk/nav-tabs";

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
// The host renders NO PageHeader of its own — each view is the existing page
// verbatim, keeping its title and every action it owns. Suppressing those
// headers would mean restructuring three working pages and relocating their
// controls, which is how a nav tidy-up becomes a feature regression.
//
// Each page is lazy, so opening Money pulls one view's bundle rather than
// three. Finances in particular carries its own charts.

const FinancesPage = lazy(() =>
  import("@/pages/finances").then((m) => ({ default: m.FinancesPage }))
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

function ViewLoading() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function FlipdeskMoneyPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = resolveMoneyView(searchParams.get("view"));

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
      <Tabs value={activeView} onValueChange={setActiveView}>
        <TabsList>
          <TabsTrigger value="finances">Finances</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
          <TabsTrigger value="reconcile">Reconcile</TabsTrigger>
        </TabsList>

        {/* Only the active view mounts — each page runs its own queries, and
            mounting all three would fire every one of them on arrival. */}
        <TabsContent value="finances" className="mt-6">
          {activeView === "finances" && (
            <Suspense fallback={<ViewLoading />}>
              <FinancesPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="expenses" className="mt-6">
          {activeView === "expenses" && (
            <Suspense fallback={<ViewLoading />}>
              <ExpensesPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="reconcile" className="mt-6">
          {activeView === "reconcile" && (
            <Suspense fallback={<ViewLoading />}>
              <ReconcilePage />
            </Suspense>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
