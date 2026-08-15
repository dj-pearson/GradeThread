import { Link, useParams } from "react-router";
import { LifeBuoy } from "lucide-react";

import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePublicHelpIndex } from "@/hooks/use-help-center";
import {
  HELP_HUB_DESCRIPTION,
  HELP_HUB_TITLE,
  helpArticlePath,
  helpCategoryPath,
  helpHubPath,
} from "@/types/help-center";
import { SITE_URL } from "@/lib/seo/site";
import { helpCollectionLd } from "@/lib/seo/help-json-ld";
import type { JsonLd } from "@/lib/seo/json-ld";

// US-2576: a Help Center category shelf, SPA renderer. Edge-SSR'd in production
// by functions/help/[[path]].ts; see the note on hub.tsx for why neither this
// page nor its parent is in PUBLIC_ROUTES.

export function HelpCategoryPage() {
  const { category: categorySlug } = useParams<{ category: string }>();
  const { data, isLoading, isError, refetch } = usePublicHelpIndex();

  const category = data?.categories.find((c) => c.slug === categorySlug);
  const articles = (data?.articles ?? [])
    .filter((a) => a.category_key === category?.key)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));

  const title = category?.title ?? HELP_HUB_TITLE;

  return (
    <MarketingLayout
      title={title}
      description={category?.summary || HELP_HUB_DESCRIPTION}
      canonicalPath={category ? helpCategoryPath(category.slug) : helpHubPath()}
      jsonLd={
        category
          ? [
              helpCollectionLd({
                name: category.title,
                description: category.summary,
                canonical: `${SITE_URL}${helpCategoryPath(category.slug)}`,
                items: articles.map((a) => ({
                  title: a.title,
                  url: `${SITE_URL}${helpArticlePath(category.slug, a.slug)}`,
                })),
              }) as JsonLd,
            ]
          : []
      }
      breadcrumbs={[
        { name: "GradeThread", url: `${SITE_URL}/` },
        { name: HELP_HUB_TITLE, url: `${SITE_URL}${helpHubPath()}` },
        ...(category
          ? [{ name: category.title, url: `${SITE_URL}${helpCategoryPath(category.slug)}` }]
          : []),
      ]}
    >
      <div className="mx-auto max-w-4xl px-4 py-12">
        <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted-foreground">
          <Link to={helpHubPath()} className="underline">
            {HELP_HUB_TITLE}
          </Link>
        </nav>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-9 w-64" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {isError && (
          <ErrorState
            title="Couldn't load this section"
            description="The article service didn't answer. Try again in a moment."
            onRetry={() => void refetch()}
          />
        )}

        {!isLoading && !isError && !category && (
          <EmptyState
            icon={LifeBuoy}
            title="No such section"
            description="It may have been renamed."
            action={{ label: "Browse the help center", to: helpHubPath() }}
          />
        )}

        {category && (
          <>
            <h1 className="text-3xl font-bold tracking-tight">{category.title}</h1>
            <p className="mt-2 max-w-[70ch] text-muted-foreground">{category.summary}</p>

            {articles.length === 0 ? (
              <EmptyState
                className="mt-8"
                icon={LifeBuoy}
                title="Nothing on this shelf yet"
                description="Articles are on the way."
              />
            ) : (
              <div className="mt-8 space-y-3">
                {articles.map((a) => (
                  <Link key={a.slug} to={helpArticlePath(category.slug, a.slug)} className="block">
                    <Card className="transition-colors hover:bg-muted/50">
                      <CardContent className="pt-6">
                        <h2 className="font-semibold">{a.title}</h2>
                        {a.summary && (
                          <p className="mt-1 text-sm text-muted-foreground">{a.summary}</p>
                        )}
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </MarketingLayout>
  );
}
