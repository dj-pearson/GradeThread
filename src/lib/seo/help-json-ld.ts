// Help Center structured data (US-2579) — the SPA copy.
//
// ⚠ THIS FILE HAS A TWIN: functions/_shared/help-json-ld.ts carries the same
// builders for the edge-SSR pages. They are duplicated rather than shared
// because functions/ is a separate tsconfig project bundled for the Workers
// runtime, and the repo already works this way everywhere else
// (src/lib/seo/json-ld.ts vs functions/_shared/blog-render.ts).
//
// What keeps them honest is src/test/help-json-ld-parity.test.ts, which feeds
// the SAME article to both and asserts the output is deeply equal. Change one
// and that test fails until you change the other.
//
// Dependency-free on purpose: no React, no `@/` alias, no imports at all. The
// SPA pays a few hundred bytes for it and the twin can stay literally identical.

export interface HelpJsonLdArticle {
  slug: string;
  title: string;
  summary: string;
  body_html: string;
  faq: Array<{ question: string; answer: string }>;
  published_at: string | null;
  reviewed_at: string | null;
  updated_at: string;
}

export interface HelpJsonLdCategory {
  title: string;
  slug: string;
  summary: string;
}

const SCHEMA = "https://schema.org";
const MAX_STEPS = 15;

/** Plain text from an HTML fragment: strip tags, decode the basics, collapse ws. */
function htmlToText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headingAnchor(text: string): string {
  return htmlToText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** A short step name from a step's full text (leading clause, capped). */
function stepName(text: string, index: number): string {
  const clause = text.split(/(?:[.:!?]|\s[-]\s)/)[0]?.trim() ?? "";
  const name = clause && clause.length <= 80 ? clause : text;
  const capped = name.length > 70 ? `${name.slice(0, 67).trimEnd()}...` : name;
  return capped || `Step ${index + 1}`;
}

export interface HelpHowToStep {
  name: string;
  text: string;
  url?: string;
}

/**
 * Ordered steps from the article body: the first <ol> (one step per <li>), else
 * the H2 outline (heading = step name, the prose after it = step text).
 *
 * Returns [] below two steps, and the caller then emits no HowTo at all. A
 * one-step HowTo is structured data that claims a procedure the page does not
 * contain, which is the kind of markup a manual action is issued for.
 */
export function deriveHelpSteps(html: string, canonical?: string): HelpHowToStep[] {
  if (!html) return [];

  const ol = html.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/i);
  if (ol?.[1]) {
    const items = [...ol[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => htmlToText(m[1] ?? ""))
      .filter(Boolean);
    if (items.length >= 2) {
      return items.slice(0, MAX_STEPS).map((text, i) => ({ name: stepName(text, i), text }));
    }
  }

  const steps: HelpHowToStep[] = [];
  const matches = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  for (let i = 0; i < matches.length; i++) {
    const raw = matches[i]![1] ?? "";
    const name = htmlToText(raw);
    if (!name) continue;
    const start = matches[i]!.index! + matches[i]![0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : html.length;
    const body = htmlToText(html.slice(start, end));
    const text = body.length > 320 ? `${body.slice(0, 317).trimEnd()}...` : body;
    steps.push({
      name,
      text: text || name,
      ...(canonical ? { url: `${canonical}#${headingAnchor(raw)}` } : {}),
    });
    if (steps.length >= MAX_STEPS) break;
  }
  return steps.length >= 2 ? steps : [];
}

/** Does this article read as a procedure? Title-driven, same test as the blog's. */
export function isHelpHowTo(article: { title: string }): boolean {
  return /\bhow[\s-]?to\b/i.test(article.title) ||
    /\bstep[\s-]?by[\s-]?step\b/i.test(article.title);
}

// NOTE: there is deliberately NO breadcrumb builder here. The SSR page uses
// breadcrumbListLd() from blog-render and the SPA gets one from MarketingLayout;
// a third implementation would be a third thing to keep in step for no gain.

export function helpFaqLd(
  faq: Array<{ question: string; answer: string }> | null | undefined,
): Record<string, unknown> | null {
  const clean = (faq ?? []).filter((f) => f?.question?.trim() && f?.answer?.trim());
  if (clean.length === 0) return null;
  return {
    "@context": SCHEMA,
    "@type": "FAQPage",
    mainEntity: clean.map((f) => ({
      "@type": "Question",
      name: f.question.trim(),
      acceptedAnswer: { "@type": "Answer", text: f.answer.trim() },
    })),
  };
}

/**
 * The article node: HowTo when the piece is a procedure with real steps,
 * TechArticle otherwise.
 *
 * dateModified is reviewed_at when the article has been reviewed, because that
 * is the date that means a human re-read it. Falling straight to updated_at
 * would move the date every time a typo was fixed.
 */
export function helpArticleLd(
  article: HelpJsonLdArticle,
  canonical: string,
): Record<string, unknown> {
  const datePublished = article.published_at ?? undefined;
  const dateModified = article.reviewed_at ?? article.updated_at ?? undefined;
  const base: Record<string, unknown> = {
    "@context": SCHEMA,
    name: article.title,
    ...(article.summary.trim() ? { description: article.summary.trim() } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    ...(datePublished ? { datePublished } : {}),
    ...(dateModified ? { dateModified } : {}),
    publisher: { "@type": "Organization", name: "GradeThread" },
  };

  if (isHelpHowTo(article)) {
    const steps = deriveHelpSteps(article.body_html, canonical);
    if (steps.length >= 2) {
      return {
        ...base,
        "@type": "HowTo",
        step: steps.map((s, i) => ({
          "@type": "HowToStep",
          position: i + 1,
          name: s.name,
          text: s.text,
          ...(s.url ? { url: s.url } : {}),
        })),
      };
    }
  }

  return { ...base, "@type": "TechArticle", headline: article.title };
}

/** The hub and the category shelves: a CollectionPage listing what is on them. */
export function helpCollectionLd(
  input: {
    name: string;
    description: string;
    canonical: string;
    items: Array<{ title: string; url: string }>;
  },
): Record<string, unknown> {
  return {
    "@context": SCHEMA,
    "@type": "CollectionPage",
    name: input.name,
    ...(input.description.trim() ? { description: input.description.trim() } : {}),
    url: input.canonical,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: input.items.length,
      itemListElement: input.items.map((it, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: it.title,
        url: it.url,
      })),
    },
  };
}
