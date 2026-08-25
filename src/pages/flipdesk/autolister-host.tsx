import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router";
import { Sparkles } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { PageHostContext } from "@/hooks/use-page-host";
import { HostViewSkeleton } from "@/components/flipdesk/host-view-skeleton";
import { resolveAutolisterView } from "@/pages/flipdesk/nav-tabs";
import { PageHelp } from "@/components/help/page-help";

// US-2161: AutoLister and Drafts were two sidebar entries, and Drafts is not a
// separate destination — it is what AutoLister produces. A seller who has just
// generated drafts is already thinking about AutoLister; making them find a
// second nav entry to see the output is the same "one question, two places"
// problem the Pricing and Sourcing merges fixed.
//
// `?view=`, not `?tab=`, to match the Money host and stay clear of any inner
// tab state a hosted page owns. See nav-tabs.ts for why that parameter split
// exists at all.
//
// NOT folded in: /autolister/queue and /autolister/bulk-edit. Those are
// task-scoped surfaces reached FROM a batch (`?batch=…`) rather than
// destinations a seller navigates to, and neither has a sidebar entry to
// remove. Turning them into tabs would put two permanently-empty strips in
// front of everyone who has no batch in flight.

const AutolisterPage = lazy(() =>
  import("@/pages/flipdesk/autolister").then((m) => ({
    default: m.FlipdeskAutolisterPage,
  }))
);
const DraftsPage = lazy(() =>
  import("@/pages/flipdesk/autolister-drafts").then((m) => ({
    default: m.FlipdeskAutolisterDraftsPage,
  }))
);

export function FlipdeskAutolisterHostPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeView = resolveAutolisterView(searchParams.get("view"));

  function setActiveView(value: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("view", value);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div className="space-y-6">
      {/* US-2548: the host names itself. Both views carried their own h1 under
          an unlabelled tab strip, so the page said "Generating listings" and
          never said AutoLister. */}
      <PageHeader
        icon={Sparkles}
        title="AutoLister"
        subtitle="Photos in, complete eBay listings out."
              actions={<PageHelp slug="batch-listing-with-autolister" />}
      />
      <PageHostContext.Provider value={{ embedded: true }}>
        <Tabs value={activeView} onValueChange={setActiveView}>
          <TabsList>
            <TabsTrigger value="generate">Generate</TabsTrigger>
            <TabsTrigger value="drafts">Drafts</TabsTrigger>
          </TabsList>

          {/* Only the active view mounts. This one matters more than the other
              hosts: the AutoLister page owns the upload store and fires the
              batch queries, and Drafts runs its own listing reads — mounting
              both on arrival would double the work for a seller who only wanted
              to check on drafts. */}
          <TabsContent value="generate" className="mt-6">
            {activeView === "generate" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <AutolisterPage />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="drafts" className="mt-6">
            {activeView === "drafts" && (
              <Suspense fallback={<HostViewSkeleton label="Loading this view" />}>
                <DraftsPage />
              </Suspense>
            )}
          </TabsContent>
        </Tabs>
      </PageHostContext.Provider>
    </div>
  );
}
