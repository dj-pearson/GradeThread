// Help Center reporting arithmetic (US-2592), kept out of the route file so the
// numbers can be tested without a database.
//
// ── THE ONE THING TO UNDERSTAND ABOUT THIS FILE ──────────────────────────────
//
// There are TWO measurement systems here and they are never added together.
//
//   PostHog  sees the React app. It has consent, it has a person, and it can
//            follow somebody from a help article into a signup. It cannot see a
//            server-rendered public help page at all, because posthog-js is not
//            on it.
//   Postgres sees the server-rendered pages, via help_article_views. It has no
//            identity, no funnel and no session — only counts.
//
// So the admin report is built from Postgres, and PostHog is where the funnel
// questions get asked. A report that required somebody to log into a third-party
// dashboard would not be a report the product has.
//
// `surface` keeps the two audiences apart inside Postgres for the same reason:
// an article everybody opens from the in-app reader and nobody ever finds
// through search is a different result from one that ranks.

export interface HelpViewRow {
  article_slug: string;
  surface: string;
  views: number;
}

export interface HelpFeedbackRow {
  article_slug: string;
  helpful: boolean;
}

export interface HelpDeflectionRow {
  article_opened: string | null;
}

export interface HelpArticleMeta {
  slug: string;
  title: string;
  category_key: string;
  visibility: string;
  published_at: string | null;
}

export interface HelpArticleReportRow {
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

/**
 * One row per article that has ANY signal, ranked by public views.
 *
 * Articles with no signal at all are omitted rather than listed with zeroes.
 * The freshness panel (US-2591) already lists every article; repeating the full
 * corpus here would bury the eight rows that carry the answer under seventy that
 * do not.
 */
export function rankArticles(
  meta: HelpArticleMeta[],
  views: HelpViewRow[],
  feedback: HelpFeedbackRow[],
  deflections: HelpDeflectionRow[],
): HelpArticleReportRow[] {
  const bySlug = new Map<string, HelpArticleReportRow>();
  const metaBySlug = new Map(meta.map((m) => [m.slug, m]));

  const ensure = (slug: string): HelpArticleReportRow => {
    const existing = bySlug.get(slug);
    if (existing) return existing;
    const m = metaBySlug.get(slug);
    const row: HelpArticleReportRow = {
      slug,
      // A view of an article that has since been deleted is still a view that
      // happened. It is labelled rather than dropped, because dropping it is how
      // a traffic cliff becomes invisible.
      title: m?.title ?? `(deleted: ${slug})`,
      category_key: m?.category_key ?? "",
      visibility: m?.visibility ?? "",
      public_views: 0,
      app_views: 0,
      helpful: 0,
      unhelpful: 0,
      deflections: 0,
    };
    bySlug.set(slug, row);
    return row;
  };

  for (const v of views) {
    const row = ensure(v.article_slug);
    if (v.surface === "app") row.app_views += Number(v.views) || 0;
    else row.public_views += Number(v.views) || 0;
  }
  for (const f of feedback) {
    const row = ensure(f.article_slug);
    if (f.helpful) row.helpful += 1;
    else row.unhelpful += 1;
  }
  for (const d of deflections) {
    if (!d.article_opened) continue;
    ensure(d.article_opened).deflections += 1;
  }

  return [...bySlug.values()].sort((a, b) =>
    b.public_views - a.public_views ||
    b.app_views - a.app_views ||
    a.slug.localeCompare(b.slug)
  );
}

/**
 * Deflection rate: of the people who reached the point of writing a ticket, what
 * share read an article and left without filing one.
 *
 * The denominator is deflections PLUS tickets, not tickets alone. Tickets alone
 * would give a rate above 100% the moment the help centre works, and it would
 * rise when ticket volume fell for reasons that had nothing to do with it.
 *
 * Returns null rather than 0 when nothing happened at all. Zero is a
 * measurement; no data is not, and a dashboard that shows "0%" for an empty week
 * is reporting a failure that did not occur.
 */
export function deflectionRate(deflected: number, tickets: number): number | null {
  const total = deflected + tickets;
  if (total <= 0) return null;
  return deflected / total;
}

export interface TicketRow {
  created_at: string;
  triage_category: string | null;
}

export interface TicketSplit {
  split_at: string;
  window_days: number;
  before: Array<{ category: string; count: number }>;
  after: Array<{ category: string; count: number }>;
  /** True once the "after" window has actually elapsed. */
  after_complete: boolean;
}

/**
 * Ticket volume by category either side of a date, in two equal windows.
 *
 * ⚠ THE CATEGORY HERE IS THE TRIAGE CATEGORY, NOT THE HELP CATEGORY. They are
 * different vocabularies with no mapping between them: triage has six values
 * assigned by the support agent (00370), help has fourteen chosen by an author.
 * Inventing a mapping would produce a chart precise enough to be believed and
 * wrong in a way nobody could check. An untriaged ticket is counted under
 * 'untriaged' rather than dropped, because dropping it would make the totals
 * disagree with the ticket queue.
 *
 * `after_complete` matters: comparing a full 30 days against 4 elapsed days
 * always shows a fall, and it is not a result.
 */
export function splitTicketsByCategory(
  tickets: TicketRow[],
  splitAt: Date,
  windowDays: number,
  now: Date,
): TicketSplit {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const start = splitAt.getTime() - windowMs;
  const end = splitAt.getTime() + windowMs;

  const before = new Map<string, number>();
  const after = new Map<string, number>();

  for (const t of tickets) {
    const at = Date.parse(t.created_at);
    if (Number.isNaN(at)) continue;
    const key = t.triage_category ?? "untriaged";
    if (at >= start && at < splitAt.getTime()) {
      before.set(key, (before.get(key) ?? 0) + 1);
    } else if (at >= splitAt.getTime() && at < end) {
      after.set(key, (after.get(key) ?? 0) + 1);
    }
  }

  const toList = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  return {
    split_at: splitAt.toISOString(),
    window_days: windowDays,
    before: toList(before),
    after: toList(after),
    after_complete: now.getTime() >= end,
  };
}

/** Clamp a `?days=` parameter to something a report can actually answer. */
export function reportWindowDays(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(365, n));
}
