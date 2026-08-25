import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { BookOpen, LifeBuoy, Lock, Search, Users } from "lucide-react";
import { SEO } from "@/components/seo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  recordHelpArticleRead,
  useHelpFeedback,
  useHelpReaderArticle,
  useHelpReaderIndex,
  useHelpReaderSearch,
} from "@/hooks/use-help-center";
import { track } from "@/lib/analytics";
import { HELP_VISIBILITY_LABELS, type HelpVisibility } from "@/types/help-center";

// US-2583: the in-app Help Center reader at /dashboard/help.
//
// It reads /api/help, which is authMiddleware-only. What comes back is the
// SERVER's decision: a signed-in customer gets public + members articles, an
// admin also gets internal ones (operator runbooks, abuse thresholds,
// unreleased work). This page never asks for a visibility — it renders what it
// is given and labels it.
//
// noindex on every page here, and /dashboard is already disallowed in
// robots.txt. src/test/help-gating.test.ts asserts no non-public article can
// reach a sitemap, llms.txt or the prerender output.

const VISIBILITY_ICON: Record<HelpVisibility, typeof Lock> = {
  public: LifeBuoy,
  members: Users,
  internal: Lock,
};

const VISIBILITY_VARIANT: Record<
  HelpVisibility,
  "default" | "secondary" | "outline" | "destructive"
> = {
  public: "secondary",
  members: "outline",
  internal: "destructive",
};

function VisibilityBadge({ visibility }: { visibility: HelpVisibility }) {
  // Public articles carry no badge: they are the default, and badging every row
  // would make the two that matter disappear into the noise.
  if (visibility === "public") return null;
  const Icon = VISIBILITY_ICON[visibility];
  return (
    <Badge variant={VISIBILITY_VARIANT[visibility]} className="ml-2 align-middle">
      <Icon className="mr-1 h-3 w-3" />
      {HELP_VISIBILITY_LABELS[visibility]}
    </Badge>
  );
}

export function HelpReaderPage() {
  const { slug } = useParams<{ slug?: string }>();
  return slug ? <HelpReaderArticle slug={slug} /> : <HelpReaderIndexPage />;
}

// ── the index ─────────────────────────────────────────────
function HelpReaderIndexPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [draft, setDraft] = useState(query);
  const [categoryFilter, setCategoryFilter] = useState("");

  const { data, isLoading, isError, refetch } = useHelpReaderIndex();
  const search = useHelpReaderSearch(query);

  const categoryTitle = useMemo(() => {
    const map = new Map((data?.categories ?? []).map((c) => [c.key, c.title]));
    return (key: string) => map.get(key) ?? key;
  }, [data]);

  const searching = query.trim().length >= 2;

  // US-2592: the in-app half of the search signal. Ref-guarded for the same
  // reason the public page is — a cached result on a back-navigation would
  // otherwise count as somebody searching again.
  const trackedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!searching || search.isLoading || search.isError) return;
    const q = query.trim();
    if (trackedRef.current === q) return;
    trackedRef.current = q;
    const hits = search.data?.hits.length ?? 0;
    track(hits === 0 ? "help_search_zero_results" : "help_search", {
      query: q,
      hits,
      surface: "app",
    });
  }, [searching, query, search.isLoading, search.isError, search.data]);
  const rows = searching
    ? (search.data?.hits ?? []).map((h) => ({
        slug: h.slug,
        title: h.title,
        summary: h.summary,
        category_key: h.category_key,
        visibility: h.visibility as HelpVisibility,
      }))
    : (data?.articles ?? [])
        .filter((a) => !categoryFilter || a.category_key === categoryFilter)
        .map((a) => ({
          slug: a.slug,
          title: a.title,
          summary: a.summary,
          category_key: a.category_key,
          visibility: a.visibility,
        }));

  const grouped = useMemo(() => {
    const buckets = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = buckets.get(r.category_key) ?? [];
      list.push(r);
      buckets.set(r.category_key, list);
    }
    return [...buckets.entries()].sort((a, b) =>
      categoryTitle(a[0]).localeCompare(categoryTitle(b[0])),
    );
  }, [rows, categoryTitle]);

  return (
    <div className="space-y-4">
      <SEO title="Help" noindex />
      <PageHeader
        title="Help"
        subtitle={
          data?.viewer === "admin"
            ? "Every article, including internal operator notes."
            : "Guides for grading, listing, selling and everything around them."
        }
        // US-2864: the glossary is a different question from "how do I do X",
        // and somebody stuck on a word rather than a task should not have to
        // search an article index to find out what a Comp is.
        actions={
          <Button asChild variant="outline">
            <Link to="/dashboard/help/glossary">
              <BookOpen className="mr-2 h-4 w-4" />
              Glossary
            </Link>
          </Button>
        }
      />

      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(draft.trim() ? { q: draft.trim() } : {});
        }}
      >
        <Label htmlFor="help-reader-q" className="sr-only">
          Search help
        </Label>
        <Input
          id="help-reader-q"
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

      {!searching && (data?.categories ?? []).length > 0 && (
        <Select
          value={categoryFilter || "all"}
          onValueChange={(v) => setCategoryFilter(v === "all" ? "" : v)}
        >
          <SelectTrigger className="w-64" aria-label="Filter by category">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(data?.categories ?? []).map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {isLoading && (
        <LoadingRegion label="Loading help" className="p-4">
          <SkeletonRows rows={6} />
        </LoadingRegion>
      )}

      {isError && (
        <ErrorState
          title="Couldn't load help"
          description="The article service didn't answer. Try again in a moment."
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={searching ? Search : LifeBuoy}
          title={searching ? `Nothing matched "${query}"` : "Nothing published yet"}
          description={
            searching
              ? "Try different words, or open a ticket and we'll answer it."
              : "Articles are on the way."
          }
          {...(searching
            ? { action: { label: "Open a support ticket", to: "/dashboard/support" } }
            : {})}
        />
      )}

      {grouped.map(([key, items]) => (
        <Card key={key}>
          <CardContent className="pt-6">
            <h2 className="text-base font-semibold">{categoryTitle(key)}</h2>
            <ul className="mt-3 space-y-3">
              {items.map((a) => (
                <li key={a.slug}>
                  <Link
                    to={`/dashboard/help/${a.slug}`}
                    className="font-medium hover:underline"
                  >
                    {a.title}
                  </Link>
                  <VisibilityBadge visibility={a.visibility} />
                  {a.summary && (
                    <p className="text-sm text-muted-foreground">{a.summary}</p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── one article ───────────────────────────────────────────
function HelpReaderArticle({ slug }: { slug: string }) {
  const { data, isLoading, isError, error, refetch } = useHelpReaderArticle(slug);
  const article = data?.article;
  const notFound = isError && (error as Error | undefined)?.message?.includes("Not found");

  const basis = article?.reviewed_at ?? article?.published_at ?? null;

  // US-2592: count the read once per article per mount. The ref is what stops a
  // TanStack cache hit on a back-navigation from counting the same read again —
  // without it the number measures navigation rather than reading.
  const countedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!article || countedRef.current === article.slug) return;
    countedRef.current = article.slug;
    recordHelpArticleRead(article.slug);
    track("help_article_view", {
      slug: article.slug,
      category: article.category_key,
      surface: "app",
    });
  }, [article]);

  return (
    <div className="space-y-4">
      <SEO title={article?.title ?? "Help"} noindex />
      <Link to="/dashboard/help" className="text-sm text-muted-foreground hover:underline">
        All help articles
      </Link>

      {isLoading && (
        <LoadingRegion label="Loading article" className="p-4">
          <SkeletonRows rows={8} />
        </LoadingRegion>
      )}

      {notFound && (
        <EmptyState
          icon={LifeBuoy}
          title="We couldn't find that article"
          description="It may have been renamed, taken down, or is not available to your account."
          action={{ label: "All help articles", to: "/dashboard/help" }}
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
          <h1 className="text-2xl font-bold tracking-tight">
            {article.title}
            <VisibilityBadge visibility={article.visibility} />
          </h1>
          {article.summary && (
            <p className="mt-2 max-w-[70ch] text-muted-foreground">{article.summary}</p>
          )}
          {basis && (
            <p className="mt-1 text-sm text-muted-foreground">
              {article.reviewed_at ? "Last reviewed" : "Published"}{" "}
              {new Date(basis).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
          )}
          <div
            className="prose prose-slate mt-6 max-w-[70ch] dark:prose-invert"
            // Server-authored article body from the admin editor, sanitised at
            // write time. Never user-submitted.
            dangerouslySetInnerHTML={{ __html: article.body_html }}
          />

          {(article.faq ?? []).length > 0 && (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">Frequently asked questions</h2>
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

          <HelpArticleFeedback slug={article.slug} />

          <p className="mt-6 text-sm text-muted-foreground">
            Didn't answer it?{" "}
            <Link to="/dashboard/support" className="underline">
              Open a support ticket
            </Link>
            .
          </p>
        </article>
      )}
    </div>
  );
}

/**
 * US-2592: "was this helpful?" for the in-app reader.
 *
 * One vote per article per visit, and the buttons are replaced by the thank-you
 * rather than staying live. A widget that lets somebody click Yes eleven times
 * is not collecting an opinion, it is collecting a click count.
 */
function HelpArticleFeedback({ slug }: { slug: string }) {
  const [voted, setVoted] = useState<boolean | null>(null);
  const feedback = useHelpFeedback();

  const vote = (helpful: boolean) => {
    setVoted(helpful);
    feedback.mutate({ slug, helpful });
    track("help_feedback_vote", { slug, helpful, surface: "app" });
  };

  if (voted !== null) {
    return (
      <p className="mt-10 text-sm text-muted-foreground" role="status">
        {voted ? "Thanks." : "Thanks. We'll take another look at this one."}
      </p>
    );
  }

  return (
    <div className="mt-10 flex items-center gap-3 text-sm">
      <span className="text-muted-foreground">Was this helpful?</span>
      <Button type="button" variant="outline" size="sm" onClick={() => vote(true)}>
        Yes
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => vote(false)}>
        No
      </Button>
    </div>
  );
}
