import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Search } from "lucide-react";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { usePublicHelpIndex, usePublicHelpSearch } from "@/hooks/use-help-center";
import {
  HELP_HUB_DESCRIPTION,
  HELP_HUB_TITLE,
  helpArticlePath,
  helpHubPath,
} from "@/types/help-center";
import { SITE_URL } from "@/lib/seo/site";

// US-2577: Help Center search, SPA renderer. Edge-SSR'd in production by
// functions/help/[[path]].ts, which answers the same URL with no JavaScript at
// all — a search box that only works after hydration does not work on the first
// paint people actually see.
//
// noindex, FOLLOW. A results page is thin, infinite and duplicative, so it is
// not something to rank, but its links must still pass equity to the articles
// it found — which a bare noindex would strand.

export function HelpSearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [draft, setDraft] = useState(query);

  const { data: index } = usePublicHelpIndex();
  const { data, isLoading, isError, refetch } = usePublicHelpSearch(query);

  const catSlug = new Map((index?.categories ?? []).map((c) => [c.key, c.slug]));
  const catTitle = new Map((index?.categories ?? []).map((c) => [c.key, c.title]));
  const hits = data?.hits ?? [];

  return (
    <MarketingLayout
      title={query ? `Search: ${query}` : "Search help"}
      description={HELP_HUB_DESCRIPTION}
      canonicalPath="/help/search"
      noindex
      breadcrumbs={[
        { name: "GradeThread", url: `${SITE_URL}/` },
        { name: HELP_HUB_TITLE, url: `${SITE_URL}${helpHubPath()}` },
        { name: "Search", url: `${SITE_URL}/help/search` },
      ]}
    >
      <div className="mx-auto max-w-3xl px-4 py-12">
        <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
          <Link to={helpHubPath()} className="underline">
            {HELP_HUB_TITLE}
          </Link>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight">Search help</h1>

        <form
          role="search"
          className="mt-6 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setParams(draft.trim() ? { q: draft.trim() } : {});
          }}
        >
          <Label htmlFor="help-search-q" className="sr-only">
            Search help
          </Label>
          <Input
            id="help-search-q"
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

        {!query && (
          <p className="mt-6 text-muted-foreground">Type what you are stuck on.</p>
        )}

        {query && isLoading && (
          <div className="mt-6 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {query && isError && (
          <ErrorState
            className="mt-6"
            title="Search didn't answer"
            description="Try again in a moment."
            onRetry={() => void refetch()}
          />
        )}

        {query && !isLoading && !isError && hits.length === 0 && (
          <EmptyState
            className="mt-6"
            icon={Search}
            title={`Nothing matched "${query}"`}
            description="Browse the shelves instead, or open a ticket and we'll answer it."
            action={{ label: "Browse the help center", to: helpHubPath() }}
            secondaryAction={{ label: "Open a support ticket", to: "/dashboard/support" }}
          />
        )}

        {hits.length > 0 && (
          <>
            <p className="mt-6 text-sm text-muted-foreground">
              {hits.length} result{hits.length === 1 ? "" : "s"} for "{query}"
            </p>
            <div className="mt-3 space-y-3">
              {hits.map((h) => (
                <Link
                  key={h.slug}
                  to={helpArticlePath(catSlug.get(h.category_key) ?? h.category_key, h.slug)}
                  className="block"
                >
                  <Card className="transition-colors hover:bg-muted/50">
                    <CardContent className="pt-6">
                      <h2 className="font-semibold">{h.title}</h2>
                      {h.summary && (
                        <p className="mt-1 text-sm text-muted-foreground">{h.summary}</p>
                      )}
                      <p className="mt-2 text-sm text-muted-foreground">
                        {catTitle.get(h.category_key) ?? h.category_key}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </MarketingLayout>
  );
}
