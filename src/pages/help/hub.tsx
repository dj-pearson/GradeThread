import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { LifeBuoy, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePublicHelpIndex } from "@/hooks/use-help-center";
import {
  HELP_HUB_DESCRIPTION,
  HELP_HUB_TITLE,
  helpCategoryPath,
  helpHubPath,
} from "@/types/help-center";
import { SITE_URL } from "@/lib/seo/site";
import { helpCollectionLd } from "@/lib/seo/help-json-ld";
import type { JsonLd } from "@/lib/seo/json-ld";

// US-2576: the Help Center hub, SPA renderer.
//
// In production a visitor gets the edge-SSR Pages Function
// (functions/help/[[path]].ts); this route is the in-app and dev renderer. Both
// read the SAME anonymous payload (/api/content/public/help), so neither can
// show a shelf the other cannot.
//
// Deliberately NOT registered in PUBLIC_ROUTES. Registering it would bake a
// snapshot into dist/ that _routes.json never serves (the Function wins) and
// list /help in the sitemap twice — the same reasoning already recorded for
// /finds, /leaderboards and /condition-index in the registry guard test.

export function HelpHubPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const { data, isLoading, isError, refetch } = usePublicHelpIndex();

  const counts = new Map<string, number>();
  for (const a of data?.articles ?? []) {
    counts.set(a.category_key, (counts.get(a.category_key) ?? 0) + 1);
  }
  const categories = (data?.categories ?? [])
    .map((c) => ({ ...c, count: c.article_count ?? counts.get(c.key) ?? 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => a.sort_order - b.sort_order);

  return (
    <MarketingLayout
      title={HELP_HUB_TITLE}
      description={HELP_HUB_DESCRIPTION}
      canonicalPath={helpHubPath()}
      jsonLd={[
        helpCollectionLd({
          name: HELP_HUB_TITLE,
          description: HELP_HUB_DESCRIPTION,
          canonical: `${SITE_URL}${helpHubPath()}`,
          items: categories.map((c) => ({
            title: c.title,
            url: `${SITE_URL}${helpCategoryPath(c.slug)}`,
          })),
        }) as JsonLd,
      ]}
    >
      <div className="mx-auto max-w-4xl px-4 py-12">
        <h1 className="text-3xl font-bold tracking-tight">{HELP_HUB_TITLE}</h1>
        <p className="mt-2 max-w-[70ch] text-muted-foreground">{HELP_HUB_DESCRIPTION}</p>

        {/* A plain GET form, so it behaves the same here as in the SSR page. */}
        <form
          role="search"
          className="mt-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const q = draft.trim();
            navigate(q ? `/help/search?q=${encodeURIComponent(q)}` : "/help/search");
          }}
        >
          <Label htmlFor="help-hub-q" className="sr-only">
            Search help
          </Label>
          <Input
            id="help-hub-q"
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What are you stuck on?"
            autoComplete="off"
          />
          <Button type="submit">
            <Search className="mr-2 h-4 w-4" /> Search
          </Button>
        </form>

        {isLoading && (
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        )}

        {isError && (
          <ErrorState
            className="mt-8"
            title="Couldn't load the help center"
            description="The article service didn't answer. Try again in a moment."
            onRetry={() => void refetch()}
          />
        )}

        {!isLoading && !isError && categories.length === 0 && (
          <EmptyState
            className="mt-8"
            icon={LifeBuoy}
            title="Nothing published yet"
            description="Articles are on the way."
          />
        )}

        {categories.length > 0 && (
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {categories.map((c) => (
              <Link key={c.key} to={helpCategoryPath(c.slug)} className="block">
                <Card className="h-full transition-colors hover:bg-muted/50">
                  <CardContent className="pt-6">
                    <h2 className="font-semibold">{c.title}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{c.summary}</p>
                    <p className="mt-3 text-sm text-muted-foreground">
                      {c.count} article{c.count === 1 ? "" : "s"}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        <p className="mt-10 text-sm text-muted-foreground">
          Still stuck? <Link to="/dashboard/support" className="underline">Open a support ticket</Link>.
        </p>
      </div>
    </MarketingLayout>
  );
}
