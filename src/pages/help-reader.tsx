import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams, useSearchParams, useNavigate } from "react-router";
import { BookOpen, LifeBuoy, Lock, Search, Users , Compass } from "lucide-react";
import { SEO } from "@/components/seo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { useGuidedPathStore } from "@/stores/guided-path-store";
import { useAuthStore } from "@/stores/auth-store";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  isHelpNotFound,
  recordHelpArticleRead,
  useHelpFeedback,
  useHelpReaderArticle,
  useHelpReaderIndex,
  useHelpReaderSearch,
} from "@/hooks/use-help-center";
import { HelpArticleBody } from "@/components/help/help-article-body";
import { inAppHelpPath } from "@/lib/help/paths";
import { buildHelpToc } from "@/lib/help/toc";
import { ALL_SURFACES, helpCategoryOf, type Surface } from "@/lib/surfaces";
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
  // Outline plus the Lock icon, not destructive red: "internal" is a label for
  // who can read it, not a warning about the article.
  internal: "outline",
};

function VisibilityBadge({ visibility }: { visibility: HelpVisibility }) {
  // Public articles carry no badge: they are the default, and badging every row
  // would make the two that matter disappear into the noise.
  if (visibility === "public") return null;
  const Icon = VISIBILITY_ICON[visibility];
  return (
    <Badge variant={VISIBILITY_VARIANT[visibility]}>
      <Icon className="mr-1 h-3 w-3" />
      {HELP_VISIBILITY_LABELS[visibility]}
    </Badge>
  );
}

interface HelpRow {
  slug: string;
  title: string;
  summary: string;
  category_key: string;
  visibility: HelpVisibility;
}

function HelpArticleRow({
  row,
  categoryLabel,
  from,
}: {
  row: HelpRow;
  categoryLabel?: string;
  /** Surface id Help was opened from, carried onto the article for "Back to". */
  from?: string;
}) {
  const showMeta = Boolean(categoryLabel) || row.visibility !== "public";
  const to = `/dashboard/help/${row.slug}${from ? `?from=${encodeURIComponent(from)}` : ""}`;
  return (
    <li>
      <Link to={to} className="font-medium hover:underline">
        {row.title}
      </Link>
      {showMeta && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {categoryLabel && <span>{categoryLabel}</span>}
          <VisibilityBadge visibility={row.visibility} />
        </div>
      )}
      {row.summary && <p className="text-sm text-muted-foreground">{row.summary}</p>}
    </li>
  );
}

/** The surface a ?from= names, when it is a real surface other than Help. */
function fromSurface(id: string | null): Surface | null {
  if (!id || id === "help") return null;
  return ALL_SURFACES.find((s) => s.id === id) ?? null;
}

export function HelpReaderPage() {
  const { slug } = useParams<{ slug?: string }>();
  // Keyed by slug so moving from one article to another mounts a fresh reader:
  // without it the vote, the counted-read ref and the scroll position of
  // article A carried straight over to article B.
  return slug ? <HelpReaderArticle key={slug} slug={slug} /> : <HelpReaderIndexPage />;
}

// ── the index ─────────────────────────────────────────────
function HelpReaderIndexPage() {
  // The query and the category live in the URL, so Back, Forward, a remount
  // and opening an article and coming back all return to the same view.
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [draft, setDraft] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);

  const indexQuery = useHelpReaderIndex();
  const { data } = indexQuery;
  const search = useHelpReaderSearch(query);

  // Only categories that exist and have something in them are offered, and a
  // ?category= naming anything else is ignored rather than trusted.
  const categories = useMemo(
    () => (data?.categories ?? []).filter((c) => (c.article_count ?? 1) > 0),
    [data],
  );
  const rawCategory = params.get("category") ?? "";
  const categoryFilter =
    data && !(data.categories ?? []).some((c) => c.key === rawCategory) ? "" : rawCategory;

  // ?from=<surface id>: Help was opened from that screen (the sidebar, the
  // header menu and a HelpLink with no article all say so). The page leads with
  // that screen's article and the rest of its category, in the pipeline's own
  // words, before the full index.
  const from = fromSurface(params.get("from"));
  const pinned = useMemo(() => {
    if (!from || !data) return null;
    const category = helpCategoryOf(from);
    const lead = from.helpSlug ? data.articles.find((a) => a.slug === from.helpSlug) : undefined;
    const rest = category
      ? data.articles.filter((a) => a.category_key === category && a.slug !== lead?.slug)
      : [];
    if (!lead && rest.length === 0) return null;
    return { lead, rest: rest.slice(0, 5), category };
  }, [from, data]);

  // One writer for the URL: functional, so a q change never drops the
  // category and a category change never drops the q.
  const updateParams = (patch: Record<string, string>, replace = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace },
    );

  // The box follows the URL (Back/Forward), not only the first render. A draft
  // that already means this query is left alone, so a trailing space typed
  // before the next word is not eaten when the debounce lands.
  useEffect(() => setDraft((d) => (d.trim() === query.trim() ? d : query)), [query]);

  // Typing searches after a short pause; Enter searches at once. replace:true
  // so a typed word is one history entry, not one per keystroke.
  useEffect(() => {
    const next = draft.trim();
    if (next === query.trim()) return;
    const t = window.setTimeout(() => updateParams({ q: next }, true), 250);
    return () => window.clearTimeout(t);
    // updateParams is recreated each render; draft and query are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, query]);

  // "/" jumps to the search box from anywhere on the page, except while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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

  // Loading, error and empty all follow the query the page is SHOWING. They
  // used to follow the index, so every new search flashed "Nothing matched"
  // (and its ticket button) while it ran, and a failed search read as zero
  // results.
  const active = searching ? search : indexQuery;
  const stale = searching && search.isPlaceholderData;

  const rows = useMemo(
    () =>
      searching
        ? (search.data?.hits ?? [])
            .filter((h) => !categoryFilter || h.category_key === categoryFilter)
            .map((h) => ({
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
            })),
    [searching, search.data, data, categoryFilter],
  );

  // Browse only. Categories go in the order the editor set (data.categories is
  // sorted by sort_order on the server, and the Select lists them the same
  // way); articles keep the server's order inside a bucket. Search does not
  // group at all: help_search returns hits by rank, and regrouping them put the
  // best hit wherever its category happened to sort.
  const grouped = useMemo(() => {
    if (searching) return [];
    const order = new Map((data?.categories ?? []).map((c, i) => [c.key, i]));
    const buckets = new Map<string, HelpRow[]>();
    for (const r of rows) {
      const list = buckets.get(r.category_key) ?? [];
      list.push(r);
      buckets.set(r.category_key, list);
    }
    const rank = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
    return [...buckets.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [searching, rows, data]);

  const navigate = useNavigate();
  const user = useAuthStore((st) => st.user);
  const startGuided = useGuidedPathStore((st) => st.start);

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
          <div className="flex flex-wrap gap-2">
            {/* US-2873 AC4: replayable from Help. The path itself runs
                exactly once by default without storing anything -- it stops
                offering itself when its steps are DONE. This is only for
                somebody who left early and wants it back. */}
            <Button
              variant="outline"
              onClick={() => {
                startGuided(user?.id);
                void navigate("/dashboard");
              }}
            >
              <Compass className="mr-2 h-4 w-4" />
              Walk me through my first listing
            </Button>
            <Button asChild variant="outline">
              <Link to="/dashboard/help/glossary">
                <BookOpen className="mr-2 h-4 w-4" />
                Glossary
              </Link>
            </Button>
          </div>
        }
      />

      <form
        role="search"
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          updateParams({ q: draft.trim() });
        }}
      >
        <Label htmlFor="help-reader-q" className="sr-only">
          Search help
        </Label>
        <Input
          ref={inputRef}
          id="help-reader-q"
          type="search"
          value={draft}
          minLength={2}
          aria-describedby={draft.trim().length === 1 ? "help-reader-q-hint" : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            // Clearing the box goes straight back to browsing, no pause.
            if (e.target.value === "") updateParams({ q: "" }, true);
          }}
          placeholder="What are you stuck on? Press / to search"
          autoComplete="off"
        />
        <Button type="submit">
          <Search className="mr-2 h-4 w-4" /> Search
        </Button>
      </form>

      {draft.trim().length === 1 && (
        <p id="help-reader-q-hint" className="text-sm text-muted-foreground">
          Type at least two letters to search.
        </p>
      )}

      {categories.length > 0 && (
        <Select
          value={categoryFilter || "all"}
          onValueChange={(v) => updateParams({ category: v === "all" ? "" : v })}
        >
          <SelectTrigger className="w-64" aria-label="Filter by category">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.title} ({c.article_count ?? 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {pinned && from && !searching && (
        <Card>
          <CardContent className="pt-6">
            <h2 className="text-base font-semibold">For {from.label}</h2>
            <ul className="mt-3 space-y-3">
              {[...(pinned.lead ? [pinned.lead] : []), ...pinned.rest].map((a) => (
                <HelpArticleRow key={a.slug} row={a} from={from.id} />
              ))}
            </ul>
            {pinned.category && (
              <Button
                variant="link"
                className="mt-2 h-auto px-0"
                onClick={() => updateParams({ category: pinned.category ?? "" })}
              >
                Everything in {categoryTitle(pinned.category)}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {active.isLoading && (
        <LoadingRegion label={searching ? "Searching help" : "Loading help"} className="p-4">
          <SkeletonRows rows={6} />
        </LoadingRegion>
      )}

      {active.isError && (
        <ErrorState
          title={searching ? "Search didn't answer. Try again." : "Couldn't load help"}
          description="The article service didn't answer. Try again in a moment."
          onRetry={() => void active.refetch()}
        />
      )}

      {!active.isLoading && !active.isError && rows.length === 0 && (
        <EmptyState
          icon={searching ? Search : LifeBuoy}
          title={
            categoryFilter
              ? searching
                ? `Nothing in ${categoryTitle(categoryFilter)} matched "${query}"`
                : `No articles in ${categoryTitle(categoryFilter)} yet`
              : searching
                ? `Nothing matched "${query}"`
                : "Nothing published yet"
          }
          description={
            searching
              ? "Try different words, or open a ticket and we'll answer it."
              : categoryFilter
                ? "Try another category."
                : "Articles are on the way."
          }
          {...(categoryFilter
            ? {
                action: {
                  label: "Show all categories",
                  onClick: () => updateParams({ category: "" }),
                },
              }
            : {})}
          {...(searching
            ? {
                [categoryFilter ? "secondaryAction" : "action"]: {
                  label: "Open a support ticket",
                  to: "/dashboard/support",
                },
              }
            : {})}
        />
      )}

      <div
        className={stale ? "space-y-4 opacity-60 transition-opacity" : "space-y-4"}
        aria-busy={stale || undefined}
      >
        {searching && rows.length > 0 && !active.isError && (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground" role="status">
                {rows.length} {rows.length === 1 ? "result" : "results"} for "{query.trim()}"
              </p>
              <ul className="mt-3 space-y-3">
                {rows.map((a) => (
                  <HelpArticleRow
                    key={a.slug}
                    row={a}
                    categoryLabel={categoryTitle(a.category_key)}
                    from={from?.id}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {grouped.map(([key, items]) => (
          <Card key={key}>
            <CardContent className="pt-6">
              <h2 className="text-base font-semibold">{categoryTitle(key)}</h2>
              <ul className="mt-3 space-y-3">
                {items.map((a) => (
                  <HelpArticleRow key={a.slug} row={a} from={from?.id} />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── one article ───────────────────────────────────────────

// UTC, so a date stored as midnight UTC does not read as the day before for a
// seller west of Greenwich.
function formatHelpDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function HelpReaderArticle({ slug }: { slug: string }) {
  const { data, isLoading, isError, error, refetch } = useHelpReaderArticle(slug);
  const article = data?.article;
  const notFound = isError && isHelpNotFound(error);
  const category = data?.category ?? null;
  const [articleParams] = useSearchParams();
  const from = fromSurface(articleParams.get("from"));

  // Section anchors, the same ids the public SSR gives the same article.
  const bodyHtml = article?.body_html;
  const { html: bodyWithAnchors, toc } = useMemo(() => buildHelpToc(bodyHtml ?? ""), [bodyHtml]);

  // Related articles come from the reader index this viewer already loaded
  // (it is the same query the Help page uses, so usually a cache hit). The
  // index is filtered to what this viewer may read, so a related slug that is
  // internal, a draft, or gone simply is not in it and is dropped.
  const index = useHelpReaderIndex();
  const related = useMemo(() => {
    const bySlug = new Map((index.data?.articles ?? []).map((a) => [a.slug, a]));
    return (article?.related_slugs ?? [])
      .filter((s) => s !== article?.slug)
      .map((s) => bySlug.get(s))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
  }, [index.data, article]);

  // A new article opens at its top with focus on its title, so a keyboard or
  // screen-reader user lands on what they just opened. A #hash wins: a link to
  // a section should arrive at that section.
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const articleSlug = article?.slug;
  useLayoutEffect(() => {
    if (!articleSlug) return;
    const id = location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
    const target = id ? document.getElementById(id) : null;
    if (target) {
      target.scrollIntoView();
      return;
    }
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, [articleSlug, location.hash]);

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
      {from?.web && (
        <Link to={from.web} className="text-sm font-medium hover:underline">
          Back to {from.label}
        </Link>
      )}
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link to="/dashboard/help" className="hover:underline">
          Help
        </Link>
        {category && (
          <>
            <span aria-hidden="true"> / </span>
            <Link
              to={`/dashboard/help?category=${encodeURIComponent(category.key)}`}
              className="hover:underline"
            >
              {category.title}
            </Link>
          </>
        )}
      </nav>

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
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight outline-none">
            {article.title}
          </h1>
          {article.visibility !== "public" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <VisibilityBadge visibility={article.visibility} />
            </div>
          )}
          {article.summary && (
            <p className="mt-2 max-w-[70ch] text-muted-foreground">{article.summary}</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            Updated {formatHelpDate(article.updated_at)}
            {article.reviewed_at && <> · Last reviewed {formatHelpDate(article.reviewed_at)}</>}
          </p>

          {article.hero_image_url && (
            // Decorative: the title above already says what the article is.
            <img
              src={article.hero_image_url}
              alt=""
              loading="eager"
              fetchPriority="high"
              className="mt-6 aspect-[16/9] w-full max-w-[70ch] rounded-xl object-cover"
            />
          )}

          {toc.length >= 2 && (
            <nav aria-label="On this page" className="mt-6 max-w-[70ch] text-sm">
              <p className="font-medium">On this page</p>
              <ul className="mt-2 space-y-1">
                {toc.map((t) => (
                  <li key={t.id}>
                    <a href={`#${t.id}`} className="text-muted-foreground hover:underline">
                      {t.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <HelpArticleBody
            html={bodyWithAnchors}
            className="mt-6 max-w-[70ch] [&_h2]:scroll-mt-20"
            linkFor={inAppHelpPath}
          />

          {(article.faq ?? []).length > 0 && (
            <section className="mt-10 max-w-[70ch]">
              <h2 className="text-lg font-semibold">Frequently asked questions</h2>
              <div className="mt-4 space-y-3">
                {(article.faq ?? []).map((f) => (
                  <details key={f.question} className="group">
                    <summary className="cursor-pointer font-medium">{f.question}</summary>
                    <p className="mt-1 text-muted-foreground">{f.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          )}

          {related.length > 0 && (
            <section className="mt-10 max-w-[70ch]">
              <h2 className="text-lg font-semibold">Related</h2>
              <ul className="mt-3 space-y-3">
                {related.map((r) => (
                  <li key={r.slug}>
                    <Link to={inAppHelpPath(r.slug)} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    {r.summary && <p className="text-sm text-muted-foreground">{r.summary}</p>}
                  </li>
                ))}
              </ul>
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
 *
 * The thank-you waits for the server. A vote that did not save (an error, or
 * the edge answering recorded:false) keeps the buttons so it can be retried,
 * instead of thanking somebody for a vote nobody has.
 *
 * A No asks what was missing before it is sent, so the one POST carries the
 * reason. The freshness report already shows comments; until now nothing
 * could send one.
 */
const NO_REASONS = [
  "Steps didn't match my screen",
  "Out of date",
  "Didn't cover my marketplace",
] as const;

function HelpArticleFeedback({ slug }: { slug: string }) {
  const [asking, setAsking] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [voted, setVoted] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const feedback = useHelpFeedback();
  const pending = feedback.isPending;

  const send = (helpful: boolean, text = "") => {
    setFailed(false);
    feedback.mutate(
      { slug, helpful, comment: text },
      {
        onSuccess: (data) => {
          if (!data.recorded) {
            setFailed(true);
            return;
          }
          setVoted(helpful);
          track("help_feedback_vote", { slug, helpful, surface: "app" });
        },
        onError: () => setFailed(true),
      },
    );
  };

  const failure = failed && (
    <p className="text-sm text-destructive" role="alert">
      That didn't save. Try again.
    </p>
  );

  if (voted !== null) {
    return (
      <div className="mt-10 space-y-1 text-sm text-muted-foreground" role="status">
        <p>{voted ? "Thanks." : "Thanks. We'll take another look at this one."}</p>
        {!voted && (
          <p>
            <Link to={`/dashboard/support?article=${encodeURIComponent(slug)}`} className="underline">
              Open a ticket about this article
            </Link>
          </p>
        )}
      </div>
    );
  }

  if (asking) {
    const toggle = (r: string) =>
      setReasons((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
    const text = [...reasons, comment.trim()].filter(Boolean).join("; ").slice(0, 1000);
    return (
      <div className="mt-10 max-w-[70ch] space-y-3 text-sm" aria-busy={pending}>
        <p className="font-medium">What was missing?</p>
        <div className="flex flex-wrap gap-2">
          {NO_REASONS.map((r) => (
            <Button
              key={r}
              type="button"
              size="sm"
              variant={reasons.includes(r) ? "secondary" : "outline"}
              aria-pressed={reasons.includes(r)}
              disabled={pending}
              onClick={() => toggle(r)}
            >
              {r}
            </Button>
          ))}
        </div>
        <Label htmlFor={`help-feedback-${slug}`} className="sr-only">
          Anything else? (optional)
        </Label>
        <Textarea
          id={`help-feedback-${slug}`}
          rows={2}
          maxLength={1000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Anything else? (optional)"
          disabled={pending}
        />
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={pending} onClick={() => send(false, text)}>
            Send
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => send(false)}>
            Skip
          </Button>
        </div>
        {failure}
      </div>
    );
  }

  return (
    <div className="mt-10 space-y-2 text-sm">
      <div className="flex items-center gap-3" aria-busy={pending}>
        <span className="text-muted-foreground">Was this helpful?</span>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => send(true)}>
          Yes
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            setFailed(false);
            setAsking(true);
          }}
        >
          No
        </Button>
      </div>
      {failure}
    </div>
  );
}
