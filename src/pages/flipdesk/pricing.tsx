import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Tag } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/ui/page-header";
import { PageHostContext } from "@/hooks/use-page-host";
import { HostViewSkeleton } from "@/components/flipdesk/host-view-skeleton";
import {
  PRICING_TAB_LABELS,
  PRICING_TABS,
  resolvePricingTab,
  type PricingTab,
} from "@/pages/flipdesk/nav-tabs";
import { PageHelp } from "@/components/help/page-help";
import { useRepricingSuggestions } from "@/hooks/use-repricing";

// US-2161: the pricing surfaces were four sidebar entries — Repricing,
// Bulk pricing, Price Suggestions and Automations — and Price Suggestions sat
// in the Grading group while the other three sat under FlipDesk, so "change my
// prices" was spread across two sections of the nav. They are one destination
// now, with ?tab= carrying the choice. Price Suggestions later folded into
// Repricing, which read the same feed with filters, bulk and Undo on top.
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
// Each page is lazy so opening Pricing pulls one tab's bundle, not three.

// The import thunks are hoisted so hovering or focusing a tab can start its
// chunk before the click. Calling one twice is free: the module is cached.
const loadRepricing = () =>
  import("@/pages/flipdesk/repricing").then((m) => ({
    default: m.FlipdeskRepricingPage,
  }));
const loadBulkPricing = () =>
  import("@/pages/flipdesk/bulk-pricing").then((m) => ({
    default: m.FlipdeskBulkPricingPage,
  }));
const loadAutomations = () =>
  import("@/pages/flipdesk/automations").then((m) => ({
    default: m.FlipdeskAutomationsPage,
  }));

const RepricingPage = lazy(loadRepricing);
const BulkPricingPage = lazy(loadBulkPricing);
const AutomationsPage = lazy(loadAutomations);

const PREFETCH: Record<PricingTab, () => Promise<unknown>> = {
  repricing: loadRepricing,
  bulk: loadBulkPricing,
  automations: loadAutomations,
};

function prefetch(tab: PricingTab) {
  // A failed prefetch is not an error: the click loads it again and the
  // Suspense boundary shows the real failure if there is one.
  PREFETCH[tab]().catch(() => undefined);
}

export function FlipdeskPricingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolvePricingTab(searchParams.get("tab"));
  // The same cached feed the Repricing tab reads, so the count costs nothing
  // extra once either has loaded.
  const { data: suggestions = [] } = useRepricingSuggestions();
  const nudgeCount = suggestions.length;

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
    // The host owns the frame: one width and one gutter for all three tabs,
    // so the left edge does not jump when the seller switches between them.
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        icon={Tag}
        title="Pricing"
        subtitle="What to charge, and what to change it to."
        actions={<PageHelp slug="pricing-your-listings" />}
      />
      <PageHostContext.Provider value={{ embedded: true }}>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          {/* Three tabs and a count do not fit a 360px phone as a strip, so
              below sm it is a picker (the Money host's pattern). */}
          <div className="sm:hidden">
            <Label htmlFor="pricing-tab" className="sr-only">
              Which part of Pricing
            </Label>
            <Select value={activeTab} onValueChange={setActiveTab}>
              <SelectTrigger id="pricing-tab" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRICING_TABS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {PRICING_TAB_LABELS[t]}
                    {t === "repricing" && nudgeCount > 0 ? ` (${nudgeCount})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <TabsList className="hidden sm:inline-flex">
            {PRICING_TABS.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                onPointerEnter={() => prefetch(t)}
                onFocus={() => prefetch(t)}
              >
                {PRICING_TAB_LABELS[t]}
                {t === "repricing" && nudgeCount > 0 && (
                  <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 tabular-nums">
                    <span className="sr-only">, </span>
                    {nudgeCount}
                    <span className="sr-only"> nudges</span>
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Only the active tab mounts — these pages each run their own queries,
              and mounting all three would fire every one of them on arrival. */}
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
