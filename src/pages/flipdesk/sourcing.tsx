import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import { Search, ScanLine } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { PageHostContext } from "@/hooks/use-page-host";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HostViewBoundary,
  HostViewSkeleton,
} from "@/components/flipdesk/host-view-skeleton";
import {
  resolveSourcingTab,
  SOURCING_TAB_LABELS,
  SOURCING_TABS,
  type SourcingTab,
} from "@/pages/flipdesk/nav-tabs";
import { PageHelp } from "@/components/help/page-help";
import { PhoneOnlyRow } from "@/components/flipdesk/phone-only-row";
import { ALL_SURFACES } from "@/lib/surfaces";

// US-2161: ScoutAI, Buy Decision, Sources and Buyer Demand were four sidebar
// entries answering one question — "what should I buy, and from where?" They are
// one destination now, with ?tab= carrying the choice. Radar and My stores
// joined later (US-1864/1865), so it is six tabs.
//
// Same contract as the Pricing host: the tab lives in the URL so deep links, the
// command palette and flipdesk-search keep working. US-2548 gave the host its
// own title; each tab keeps every action it owns and loses only its duplicate
// heading. Import and Consignment deliberately stay separate entries — they are
// not part of the buy decision.
//
// Each page is lazy so opening Sourcing pulls one tab's bundle, not six.
//
// SRC-10: the six tabs render from one table, so a seventh cannot be half-wired
// (a trigger with no content, or a content block with the wrong Suspense). The
// import thunks are hoisted so hovering or focusing a tab starts its chunk
// before the click; calling one twice is free, the module is cached.

type TabModule = { default: ComponentType };

const SOURCING_LOADERS: Record<SourcingTab, () => Promise<TabModule>> = {
  scout: () => import("@/pages/flipdesk/scout").then((m) => ({ default: m.FlipdeskScoutPage })),
  buy: () => import("@/pages/flipdesk/scout-buy").then((m) => ({ default: m.FlipdeskScoutBuyPage })),
  radar: () => import("@/pages/flipdesk/radar").then((m) => ({ default: m.FlipdeskRadarPage })),
  stores: () =>
    import("@/pages/flipdesk/my-stores").then((m) => ({ default: m.FlipdeskMyStoresPage })),
  sources: () =>
    import("@/pages/flipdesk/sources").then((m) => ({ default: m.FlipdeskSourcesPage })),
  demand: () => import("@/pages/flipdesk/demand").then((m) => ({ default: m.FlipdeskDemandPage })),
};

function prefetch(tab: SourcingTab) {
  // A failed prefetch is not an error: the click loads it again and the tab's
  // boundary shows the real failure if there is one.
  SOURCING_LOADERS[tab]().catch(() => undefined);
}

function lazyPages(): Record<SourcingTab, LazyExoticComponent<ComponentType>> {
  return Object.fromEntries(
    SOURCING_TABS.map((t) => [t, lazy(SOURCING_LOADERS[t])]),
  ) as Record<SourcingTab, LazyExoticComponent<ComponentType>>;
}

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

  // Recreated on Retry, because React.lazy caches a rejected import for good.
  const [attempt, setAttempt] = useState(0);
  const pages = useMemo(lazyPages, [attempt]);

  // The next step after finding a deal is checking it, so Buy decision's
  // chunk is warmed as soon as Scout is on screen.
  useEffect(() => {
    if (activeTab === "scout") prefetch("buy");
  }, [activeTab]);

  return (
    // SRC-11: ONE content frame for every tab. Scout, Buy and Demand each set
    // their own width and gutter, so the left edge jumped on every switch.
    // Embedded, they now defer to this.
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        icon={Search}
        title="Sourcing"
        subtitle="What to buy, what to pay, and where to find it."
        actions={<PageHelp slug="deciding-what-to-buy" />}
      />
      <PageHostContext.Provider value={{ embedded: true }}>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          {/* Six tabs are about 550px as a strip and a phone is 360, so below
              md it is a picker (the Pricing host's pattern). */}
          <div className="md:hidden">
            <Label htmlFor="sourcing-tab" className="sr-only">
              Which part of Sourcing
            </Label>
            <Select value={activeTab} onValueChange={setActiveTab}>
              <SelectTrigger id="sourcing-tab" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCING_TABS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {SOURCING_TAB_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <TabsList className="hidden md:inline-flex">
            {SOURCING_TABS.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                onPointerEnter={() => prefetch(t)}
                onFocus={() => prefetch(t)}
              >
                {SOURCING_TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Only the active tab mounts — each of these runs its own queries. */}
          {SOURCING_TABS.map((t) => {
            const Page = pages[t];
            return (
              <TabsContent key={t} value={t} className="mt-6">
                {activeTab === t && (
                  <HostViewBoundary onRetry={() => setAttempt((n) => n + 1)}>
                    <Suspense fallback={<HostViewSkeleton label="Loading this tab" />}>
                      <Page />
                    </Suspense>
                  </HostViewBoundary>
                )}
              </TabsContent>
            );
          })}
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
