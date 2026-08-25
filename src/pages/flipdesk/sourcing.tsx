import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Search, ScanLine } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { PageHostContext } from "@/hooks/use-page-host";
import { HostViewSkeleton } from "@/components/flipdesk/host-view-skeleton";
import { resolveSourcingTab } from "@/pages/flipdesk/nav-tabs";
import { PageHelp } from "@/components/help/page-help";
import { PhoneOnlyRow } from "@/components/flipdesk/phone-only-row";
import { ALL_SURFACES } from "@/lib/surfaces";

// US-2161: ScoutAI, Buy Decision, Sources and Buyer Demand were four sidebar
// entries answering one question — "what should I buy, and from where?" They are
// one destination now, with ?tab= carrying the choice.
//
// Same contract as the Pricing host: the tab lives in the URL so deep links, the
// command palette and flipdesk-search keep working. US-2548 gave the host its
// own title; each tab keeps every action it owns and loses only its duplicate
// heading. Import and Consignment deliberately stay separate entries — they are
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



// Read from the registry (US-2876) rather than retyped, so the row and the
// iOS Tools hub cannot end up describing Prospect differently.
const PROSPECT = ALL_SURFACES.find((s) => s.id === "prospect")!;

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
      <PageHeader
        icon={Search}
        title="Sourcing"
        subtitle="What to buy, what to pay, and where to find it."
              actions={<PageHelp slug="deciding-what-to-buy" />}
      />
      <PageHostContext.Provider value={{ embedded: true }}>
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
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <ScoutPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="buy" className="mt-6">
            {activeTab === "buy" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <ScoutBuyPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="radar" className="mt-6">
            {activeTab === "radar" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <RadarPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="stores" className="mt-6">
            {activeTab === "stores" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <MyStoresPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="sources" className="mt-6">
            {activeTab === "sources" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <SourcesPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="demand" className="mt-6">
            {activeTab === "demand" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                <DemandPage />
              </Suspense>
            )}
          </TabsContent>
        </Tabs>
      </PageHostContext.Provider>

      {/* US-2878: Prospect is the fourth way to decide what to buy and it only
          exists on the phone. Saying nothing was the actual bug -- a
          desktop-first seller had no way to learn the product does this.
          Below the tabs rather than above them: it is a thing that also
          exists, not a thing competing with the tool they came for. */}
      <PhoneOnlyRow
        icon={ScanLine}
        label={PROSPECT.label}
        description={PROSPECT.description}
        why="It is for when you are standing in the shop, so it lives where the camera is."
      />
    </div>
  );
}
