import { Suspense, type ComponentType, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { LucideIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { TabHostContext } from "@/hooks/use-account-hub";

// US-2559: the shape all four consolidated admin hosts share.
//
// Written once rather than four times because the previous consolidation
// (US-2161) produced four near-identical FlipDesk hosts that then drifted —
// US-2548 had to fix the same missing title, the same bare spinner and the same
// unsuppressed child heading in all four.
//
// What this bakes in, so no host can forget it:
//
//   • A TITLE (US-2548's finding): a tab strip with no name leaves the screen
//     reading app header → unlabelled tabs → the CHILD page's title, so the
//     destination the sidebar sent you to never names itself.
//   • Only the ACTIVE view mounts. Each hosted admin page runs its own queries,
//     several of them polling; mounting all five on arrival would fire every one
//     of them.
//   • TabHostContext, so the hosted page drops the title that now duplicates the
//     tab label while KEEPING its actions.
//   • A skeleton fallback, not a spinner.

export interface AdminHostView<V extends string> {
  value: V;
  label: string;
  /** Lazily-imported page component. */
  Component: ComponentType;
}

export function AdminTabHost<V extends string>({
  title,
  subtitle,
  icon,
  views,
  resolve,
  /**
   * Rendered ABOVE the tab strip, on every view. For anything that must stay
   * immediate after a merge rather than living one click inside a tab.
   */
  banner,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  views: ReadonlyArray<AdminHostView<V>>;
  resolve: (raw: string | null | undefined) => V;
  banner?: ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const active = resolve(params.get("view"));

  function setActive(value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("view", value);
        // A hosted page's OWN `?tab=` belongs to that page. Carrying it across
        // would leave a key on the URL that means nothing on the new view and
        // then reappears if the operator tabs back.
        next.delete("tab");
        return next;
      },
      // replace, not push: flipping views should not fill the back button with
      // steps someone has to walk out of to leave the page.
      { replace: true },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={title} subtitle={subtitle} icon={icon} />

      {banner}

      <TabHostContext.Provider value={{ embedded: true }}>
        <Tabs value={active} onValueChange={setActive}>
          <TabsList>
            {views.map((v) => (
              <TabsTrigger key={v.value} value={v.value}>
                {v.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {views.map(({ value, Component }) => (
            <TabsContent key={value} value={value} className="mt-6">
              {active === value && (
                <Suspense fallback={<AdminViewLoading />}>
                  <Component />
                </Suspense>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </TabHostContext.Provider>
    </div>
  );
}

function AdminViewLoading() {
  return (
    <LoadingRegion label="Loading view" className="space-y-4">
      <Skeleton className="h-8 w-56" aria-hidden="true" />
      <SkeletonRows rows={6} />
    </LoadingRegion>
  );
}
