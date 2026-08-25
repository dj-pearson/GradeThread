import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Tag } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { PageHostContext } from "@/hooks/use-page-host";
import { HostViewSkeleton } from "@/components/flipdesk/host-view-skeleton";
import { resolvePricingTab } from "@/pages/flipdesk/nav-tabs";
import { PageHelp } from "@/components/help/page-help";

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
// US-2548: the host names itself. It used to render no PageHeader, so a seller
// landing here saw an unlabelled tab strip over a page titled "Repricing", and
// the word "Pricing" only in the sidebar. Each tab keeps every action it owns —
// PageHeader drops just the duplicate title, via PageHostContext.embedded.
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
      <PageHeader
        icon={Tag}
        title="Pricing"
        subtitle="What to charge, and what to change it to."
              actions={<PageHelp slug="pricing-your-listings" />}
      />
      <PageHostContext.Provider value={{ embedded: true }}>
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
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <RepricingPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="bulk" className="mt-6">
            {activeTab === "bulk" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <BulkPricingPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="suggestions" className="mt-6">
            {activeTab === "suggestions" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <PriceSuggestionsPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="automations" className="mt-6">
            {activeTab === "automations" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <AutomationsPage />
              </Suspense>
            )}
          </TabsContent>
        </Tabs>
      </PageHostContext.Provider>
    </div>
  );
}
