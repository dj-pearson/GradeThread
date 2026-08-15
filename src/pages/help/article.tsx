import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { LifeBuoy } from "lucide-react";

import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePublicHelpArticle } from "@/hooks/use-help-center";
import {
  HELP_HUB_DESCRIPTION,
  HELP_HUB_TITLE,
  helpArticlePath,
  helpCategoryPath,
  helpHubPath,
} from "@/types/help-center";
import { SITE_URL } from "@/lib/seo/site";
import { helpArticleLd, helpFaqLd } from "@/lib/seo/help-json-ld";
import type { JsonLd } from "@/lib/seo/json-ld";

// US-2576: a Help Center article, SPA renderer. Edge-SSR'd in production by
// functions/help/[[path]].ts; see the note on hub.tsx for why it is not in
// PUBLIC_ROUTES.
//
// The body is server-authored HTML from the admin editor, sanitised at write
// time by the same Tiptap pipeline the blog uses, and it is the ONLY thing this
// page injects. It is not user-submitted content.

export function HelpArticlePage() {
  const { category: categorySlug, slug } = useParams<{ category: string; slug: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = usePublicHelpArticle(slug);

  const article = data?.article;
  const category = data?.category;
  const notFound = isError && (error as Error | undefined)?.message === "not_found";

  // An article re-filed onto another shelf keeps its slug, so the old path still
  // resolves. Replace it with the canonical one rather than rendering the same
  // body at two addresses — the Function 301s for exactly the same reason.
  useEffect(() => {
    if (!article || !category) return;
    if (categorySlug !== category.slug) {
      navigate(helpArticlePath(category.slug, article.slug), { replace: true });
    }
  }, [article, category, categorySlug, navigate]);

  const reviewedBasis = article?.reviewed_at ?? article?.published_at ?? null;

  return (
    <MarketingLayout
      title={article?.title ?? HELP_HUB_TITLE}
      description={article?.summary || HELP_HUB_DESCRIPTION}
      canonicalPath={
        article && category ? helpArticlePath(category.slug, article.slug) : helpHubPath()
      }
      // Same builders the SSR Function uses, held to it by
      // src/test/help-json-ld-parity.test.ts. MarketingLayout already emits
      // Organization + BreadcrumbList, so only the page-type nodes go here.
      jsonLd={
        article && category
          ? ([
              helpArticleLd(
                {
                  slug: article.slug,
                  title: article.title,
                  summary: article.summary,
                  body_html: article.body_html,
                  faq: article.faq ?? [],
                  published_at: article.published_at,
                  reviewed_at: article.reviewed_at,
                  updated_at: article.updated_at,
                },
                `${SITE_URL}${helpArticlePath(category.slug, article.slug)}`,
              ),
              helpFaqLd(article.faq),
            ].filter(Boolean) as JsonLd[])
          : []
      }
      breadcrumbs={[
        { name: "GradeThread", url: `${SITE_URL}/` },
        { name: HELP_HUB_TITLE, url: `${SITE_URL}${helpHubPath()}` },
        ...(category
          ? [{ name: category.title, url: `${SITE_URL}${helpCategoryPath(category.slug)}` }]
          : []),
        ...(article && category
          ? [
              {
                name: article.title,
                url: `${SITE_URL}${helpArticlePath(category.slug, article.slug)}`,
              },
            ]
          : []),
      ]}
    >
      <div className="mx-auto max-w-3xl px-4 py-12">
        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        )}

        {notFound && (
          <EmptyState
            icon={LifeBuoy}
            title="We couldn't find that article"
            description="It may have been renamed or taken down."
            action={{ label: "Browse the help center", to: helpHubPath() }}
          />
        )}

        {isError && !notFound && (
          <ErrorState
            title="Couldn't load this article"
            description="The article service didn't answer. Try again in a moment."
            onRetry={() => void refetch()}
          />
        )}

        {article && (
          <article>
            <h1 className="text-3xl font-bold tracking-tight">{article.title}</h1>
            {article.summary && (
              <p className="mt-2 max-w-[70ch] text-muted-foreground">{article.summary}</p>
            )}
            {reviewedBasis && (
              <p className="mt-2 text-sm text-muted-foreground">
                {article.reviewed_at ? "Last reviewed" : "Published"}{" "}
                {new Date(reviewedBasis).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
            )}
            {article.hero_image_url && (
              <img
                src={article.hero_image_url}
                alt={article.title}
                loading="lazy"
                className="mt-6 w-full rounded-xl"
              />
            )}
            <div
              className="prose prose-slate mt-6 max-w-[70ch] dark:prose-invert"
              // Server-authored article body from the admin editor, sanitised at
              // write time. Never user-submitted.
              dangerouslySetInnerHTML={{ __html: article.body_html }}
            />

            {(article.faq ?? []).length > 0 && (
              <section className="mt-10">
                <h2 className="text-xl font-semibold">Frequently asked questions</h2>
                <dl className="mt-4 space-y-4">
                  {(article.faq ?? []).map((f, i) => (
                    <div key={i}>
                      <dt className="font-medium">{f.question}</dt>
                      <dd className="mt-1 text-muted-foreground">{f.answer}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {article.pillar_path && (
              <p className="mt-8 text-sm text-muted-foreground">
                Part of our{" "}
                <Link to={article.pillar_path} className="underline">
                  guide
                </Link>
                .
              </p>
            )}
          </article>
        )}

        <p className="mt-10 text-sm text-muted-foreground">
          Didn't answer it?{" "}
          <Link to="/dashboard/support" className="underline">
            Open a support ticket
          </Link>
          .
        </p>
      </div>
    </MarketingLayout>
  );
}
