import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resolveSourcingTab } from "@/pages/flipdesk/nav-tabs";

// US-2161: ScoutAI, Buy Decision, Sources and Buyer Demand were four sidebar
// entries answering one question — "what should I buy, and from where?" They are
// one destination now, with ?tab= carrying the choice.
//
// Same contract as the Pricing host: the tab lives in the URL so deep links, the
// command palette and flipdesk-search keep working, and the host renders no
// PageHeader of its own so each tab keeps its own title and every action button
// it owns. Import and Consignment deliberately stay separate entries — they are
// not part of the buy decision, and the story names exactly these four.
//
// Each page is lazy so opening Sourcing pulls one tab's bundle, not four.

const ScoutPage = lazy(() =>
  import("@/pages/flipdesk/scout").then((m) => ({
    default: m.FlipdeskScoutPage,
  }))
);
const ScoutBuyPage = lazy(() =>
  import("@/pages/flipdesk/scout-buy").then((m) => ({
    default: m.FlipdeskScoutBuyPage,
  }))
);
const RadarPage = lazy(() =>
  import("@/pages/flipdesk/radar").then((m) => ({
    default: m.FlipdeskRadarPage,
  }))
);
const MyStoresPage = lazy(() =>
  import("@/pages/flipdesk/my-stores").then((m) => ({
    default: m.FlipdeskMyStoresPage,
  }))
);
const SourcesPage = lazy(() =>
  import("@/pages/flipdesk/sources").then((m) => ({
    default: m.FlipdeskSourcesPage,
  }))
);
const DemandPage = lazy(() =>
  import("@/pages/flipdesk/demand").then((m) => ({
    default: m.FlipdeskDemandPage,
  }))
);



function TabLoading() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function FlipdeskSourcingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveSourcingTab(searchParams.get("tab"));

  function setActiveTab(value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="scout">ScoutAI</TabsTrigger>
          <TabsTrigger value="buy">Buy decision</TabsTrigger>
          <TabsTrigger value="radar">Radar</TabsTrigger>
          <TabsTrigger value="stores">My stores</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="demand">Buyer demand</TabsTrigger>
        </TabsList>

        {/* Only the active tab mounts — each of these runs its own queries. */}
        <TabsContent value="scout" className="mt-6">
          {activeTab === "scout" && (
            <Suspense fallback={<TabLoading />}>
              <ScoutPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="buy" className="mt-6">
          {activeTab === "buy" && (
            <Suspense fallback={<TabLoading />}>
              <ScoutBuyPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="radar" className="mt-6">
          {activeTab === "radar" && (
            <Suspense fallback={<TabLoading />}>
              <RadarPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="stores" className="mt-6">
          {activeTab === "stores" && (
            <Suspense fallback={<TabLoading />}>
              <MyStoresPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="sources" className="mt-6">
          {activeTab === "sources" && (
            <Suspense fallback={<TabLoading />}>
              <SourcesPage />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="demand" className="mt-6">
          {activeTab === "demand" && (
            <Suspense fallback={<TabLoading />}>
              <DemandPage />
            </Suspense>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
