import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resolvePricingTab } from "@/pages/flipdesk/nav-tabs";

// US-2161: the four pricing surfaces were four sidebar entries — Repricing,
// Bulk pricing, Price Suggestions and Automations — and Price Suggestions sat
// in the Grading group while the other three sat under FlipDesk, so "change my
// prices" was spread across two sections of the nav. They are one destination
// now, with ?tab= carrying the choice.
//
// Follows the pattern US-963 proved on Reconcile: the tab lives in the URL, so a
// deep link, the command palette and flipdesk-search all keep working, and a
// refresh or a shared link lands on the same tab.
//
// The host deliberately renders NO PageHeader of its own. Each tab is the
// existing page, verbatim — its title, its subtitle, and every action button it
// owns. Suppressing those headers would have meant restructuring four working
// pages and relocating their controls, which is how a nav tidy-up turns into a
// feature regression. A tab strip above a section title is a familiar shape and
// costs nothing.
//
// Each page is lazy so opening Pricing pulls one tab's bundle, not four.

const RepricingPage = lazy(() =>
  import("@/pages/flipdesk/repricing").then((m) => ({
    default: m.FlipdeskRepricingPage,
  }))
);
const BulkPricingPage = lazy(() =>
  import("@/pages/flipdesk/bulk-pricing").then((m) => ({
    default: m.FlipdeskBulkPricingPage,
  }))
);
const PriceSuggestionsPage = lazy(() =>
  import("@/pages/price-suggestions").then((m) => ({
    default: m.PriceSuggestionsPage,
  }))
);
const AutomationsPage = lazy(() =>
  import("@/pages/flipdesk/automations").then((m) => ({
    default: m.FlipdeskAutomationsPage,
  }))
);



function TabLoading() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function FlipdeskPricingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolvePricingTab(searchParams.get("tab"));

  function setActiveTab(value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", value);
        return next;
      },
      // replace, not push: flipping tabs shouldn't fill the back button with
      // steps the seller has to walk out of to leave the page.
      { replace: true },
    );
  }

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="repricing">Repricing</TabsTrigger>
          <TabsTrigger value="bulk">Bulk pricing</TabsTrigger>
          <TabsTrigger value="suggestions">Price suggestions</TabsTrigger>
          <TabsTrigger value="automations">Automations</TabsTrigger>
        </TabsList>

        {/* Only the active tab mounts — these pages each run their own queries,
            and mounting all four would fire every one of them on arrival. */}
        <TabsContent value="repricing" className="mt-6">
          {activeTab === "repricing" && (
            <Suspense fallback={<TabLoading />}>
              <RepricingPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="bulk" className="mt-6">
          {activeTab === "bulk" && (
            <Suspense fallback={<TabLoading />}>
              <BulkPricingPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="suggestions" className="mt-6">
          {activeTab === "suggestions" && (
            <Suspense fallback={<TabLoading />}>
              <PriceSuggestionsPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="automations" className="mt-6">
          {activeTab === "automations" && (
            <Suspense fallback={<TabLoading />}>
              <AutomationsPage />
            </Suspense>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
