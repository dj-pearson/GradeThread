import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";
import type {
  HelpArticle,
  HelpArticleInput,
  HelpCategory,
  HelpVisibility,
} from "@/types/help-center";

// Help Center hooks (US-2574). Two audiences, two base paths:
//   /api/content/help  admin authoring (this file's mutations + the full list)
//   /api/help          the members-only reader (US-2583)
// Both go through edgeFetch, which mints a fresh access token per request and
// retries once on a 401 with a force-refreshed token (US-1634) — the reason the
// content hooks stopped dying when an admin's tab lapsed past the 1h boundary.

async function jfetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const res = await edgeFetch(path, { ...init, json: init?.json, silentGate: true });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error || `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

const ARTICLES_KEY = ["help_articles"];
const CATEGORIES_KEY = ["help_categories"];
const PUBLIC_KEY = ["help_public"];

// ───────────────────────────────────────────────────────────────────
// PUBLIC READS (US-2576)
//
// The SPA twin of functions/help/[[path]].ts. In production a visitor lands on
// the edge-rendered page; these hooks serve in-app navigation and dev, and they
// read the SAME anonymous endpoint the Function does, so neither surface can
// show an article the other cannot. No auth header: sending one would let a
// members-only article render on a page whose URL is public.
// ───────────────────────────────────────────────────────────────────

export interface PublicHelpIndex {
  categories: HelpCategory[];
  articles: Array<
    Pick<
      HelpArticle,
      | "slug"
      | "title"
      | "summary"
      | "category_key"
      | "audience"
      | "visibility"
      | "sort_order"
      | "updated_at"
      | "reviewed_at"
    >
  >;
}

async function publicFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${edgeApiUrl()}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(res.status === 404 ? "not_found" : "Couldn't load help.");
  return (await res.json()) as T;
}

export function usePublicHelpIndex() {
  return useQuery({
    queryKey: PUBLIC_KEY,
    staleTime: 5 * 60_000,
    queryFn: () => publicFetch<PublicHelpIndex>("/api/content/public/help"),
  });
}

export interface HelpSearchHit {
  slug: string;
  title: string;
  summary: string;
  category_key: string;
  visibility: string;
  rank: number;
}

/**
 * Public help search. Two characters minimum, matching the edge's own floor:
 * a single character matches most of the corpus and costs a full index scan to
 * say so.
 */
export function usePublicHelpSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: [...PUBLIC_KEY, "search", q.toLowerCase()],
    enabled: q.length >= 2,
    staleTime: 60_000,
    queryFn: () =>
      publicFetch<{ query: string; hits: HelpSearchHit[] }>(
        `/api/content/public/help/search?q=${encodeURIComponent(q)}`,
      ),
  });
}

export function usePublicHelpArticle(slug: string | undefined) {
  return useQuery({
    queryKey: [...PUBLIC_KEY, slug],
    enabled: Boolean(slug),
    retry: false,
    queryFn: () =>
      publicFetch<{ article: HelpArticle; category: HelpCategory | null }>(
        `/api/content/public/help/${encodeURIComponent(slug!)}`,
      ),
  });
}

export function useHelpCategories() {
  return useQuery({
    queryKey: CATEGORIES_KEY,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const data = await jfetch<{ categories: HelpCategory[] }>(
        "/api/content/help/categories",
      );
      return data.categories;
    },
  });
}

// ───────────────────────────────────────────────────────────────────
// THE MEMBERS-ONLY READER (US-2583)
//
// /api/help is authMiddleware-only, and the handler resolves the viewer from
// the verified user id: a customer gets 'public' + 'members', an admin also
// gets 'internal'. That decision is the server's — these hooks send a token and
// render whatever comes back, and the `viewer` field is for LABELLING the rows,
// never for deciding what to request.
// ───────────────────────────────────────────────────────────────────

export type HelpViewerTier = "anon" | "member" | "admin";

export interface HelpReaderIndex {
  categories: HelpCategory[];
  articles: HelpArticle[];
  viewer: HelpViewerTier;
}

export function useHelpReaderIndex() {
  return useQuery({
    queryKey: ["help_reader"],
    staleTime: 60_000,
    queryFn: () => jfetch<HelpReaderIndex>("/api/help"),
  });
}

export function useHelpReaderArticle(slug: string | undefined) {
  return useQuery({
    queryKey: ["help_reader", slug],
    enabled: Boolean(slug),
    retry: false,
    queryFn: () =>
      jfetch<{ article: HelpArticle; category: HelpCategory | null; viewer: HelpViewerTier }>(
        `/api/help/${encodeURIComponent(slug!)}`,
      ),
  });
}

export function useHelpReaderSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["help_reader", "search", q.toLowerCase()],
    enabled: q.length >= 2,
    staleTime: 60_000,
    queryFn: () =>
      jfetch<{ query: string; hits: HelpSearchHit[]; viewer: HelpViewerTier }>(
        `/api/help/search?q=${encodeURIComponent(q)}`,
      ),
  });
}

/**
 * US-2592: count an in-app read, under surface 'app'.
 *
 * Fire-and-forget, and deliberately NOT a mutation: nothing in the UI depends on
 * whether it landed, and a failed analytics write must not produce a toast on a
 * page somebody was only trying to read.
 *
 * The public SSR pages count themselves from the Pages Function. This one is
 * separate on purpose — an article everybody opens from inside the product and
 * nobody ever finds through search is a different result.
 */
export function recordHelpArticleRead(slug: string): void {
  void jfetch(`/api/help/${encodeURIComponent(slug)}/view`, { method: "POST" }).catch(() => {
    /* analytics must never surface to the reader */
  });
}

/**
 * US-2592: vote on an article from inside the app.
 *
 * The public form can only accept votes on PUBLIC articles, so this is the only
 * way a members-only or internal article ever gets rated — and those are the
 * ones with no other feedback channel, because nobody lands on an operator
 * runbook from a search engine.
 */
export function useHelpFeedback() {
  return useMutation({
    mutationFn: (input: { slug: string; helpful: boolean; comment?: string }) =>
      jfetch<{ ok: boolean; recorded: boolean }>(
        `/api/help/${encodeURIComponent(input.slug)}/feedback`,
        {
          method: "POST",
          json: { helpful: input.helpful ? "yes" : "no", comment: input.comment ?? "" },
        },
      ),
    onError: () => toast.error("Couldn't record that. Try again in a moment."),
  });
}

// ───────────────────────────────────────────────────────────────────
// FRESHNESS (US-2591)
//
// A stale article is FLAGGED, never unpublished and never dropped from the
// sitemap. A page that vanishes because nobody re-read it is worse for a
// reader than one that is slightly out of date, and silently dropping URLs is
// how a section loses its ranking without anybody deciding to.
// ───────────────────────────────────────────────────────────────────

export interface HelpFreshnessRow {
  slug: string;
  title: string;
  category_key: string;
  visibility: HelpVisibility;
  reviewed_at: string | null;
  published_at: string | null;
  review_interval_days: number;
  is_stale: boolean;
  days_since_basis: number;
  feedback: { helpful: number; unhelpful: number; comments: string[] };
}

export function useHelpFreshness() {
  return useQuery({
    queryKey: ["help_freshness"],
    staleTime: 60_000,
    queryFn: async () => {
      const data = await jfetch<{ articles: HelpFreshnessRow[] }>(
        "/api/content/help/freshness",
      );
      return data.articles;
    },
  });
}

// ───────────────────────────────────────────────────────────────────
// THE REPORT (US-2592)
//
// Built from Postgres, not from PostHog. The surface that earns the organic
// traffic is server-rendered and posthog-js is not on it, and a report that
// lived in a third-party dashboard would not be a report the product has.
// ───────────────────────────────────────────────────────────────────

export interface HelpReportArticle {
  slug: string;
  title: string;
  category_key: string;
  visibility: string;
  public_views: number;
  app_views: number;
  helpful: number;
  unhelpful: number;
  deflections: number;
}

export interface HelpZeroResultQuery {
  normalized: string;
  sample: string;
  misses: number;
  last_seen: string;
  anon_misses: number;
}

export interface HelpReport {
  window_days: number;
  since: string;
  articles: HelpReportArticle[];
  zero_result_queries: HelpZeroResultQuery[];
  deflection: { deflected: number; tickets: number; rate: number | null };
  tickets: {
    split_at: string;
    window_days: number;
    before: Array<{ category: string; count: number }>;
    after: Array<{ category: string; count: number }>;
    after_complete: boolean;
  };
}

export function useHelpReport(days: number) {
  return useQuery({
    queryKey: ["help_report", days],
    staleTime: 60_000,
    queryFn: () => jfetch<HelpReport>(`/api/content/help/report?days=${days}`),
  });
}

/** Every article including drafts and internals. Admin only, by the mount. */
export function useHelpArticles() {
  return useQuery({
    queryKey: ARTICLES_KEY,
    staleTime: 30_000,
    queryFn: async () => {
      const data = await jfetch<{ articles: HelpArticle[] }>("/api/content/help");
      return data.articles;
    },
  });
}

export function useHelpArticle(id: string | undefined) {
  return useQuery({
    queryKey: [...ARTICLES_KEY, id],
    enabled: Boolean(id),
    queryFn: async () => {
      const data = await jfetch<{ article: HelpArticle }>(`/api/content/help/${id}`);
      return data.article;
    },
  });
}

export function useCreateHelpArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: HelpArticleInput) => {
      const data = await jfetch<{ article: HelpArticle }>("/api/content/help", {
        method: "POST",
        json: input,
      });
      return data.article;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ARTICLES_KEY });
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useUpdateHelpArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: HelpArticleInput & { id: string }) => {
      const data = await jfetch<{ article: HelpArticle }>(`/api/content/help/${id}`, {
        method: "PATCH",
        json: input,
      });
      return data.article;
    },
    onSuccess: (article) => {
      void qc.invalidateQueries({ queryKey: ARTICLES_KEY });
      void qc.setQueryData([...ARTICLES_KEY, article.id], article);
    },
    onError: (e: Error) => toastError(e),
  });
}

export function useDeleteHelpArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await jfetch<{ ok: true }>(`/api/content/help/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: () => {
      toast.success("Article deleted.");
      void qc.invalidateQueries({ queryKey: ARTICLES_KEY });
    },
    onError: (e: Error) => toastError(e),
  });
}
