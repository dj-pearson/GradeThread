// US-2747: the public style-code lookup page.
//
// A reseller holding a Lululemon garment reads the code off its size dot and
// wants the product name. That search happens thousands of times a day on
// somebody else's site; this is ours, and it answers with something they cannot
// show — WHERE the name came from, and how many independent confirmations
// stand behind it.
//
// ── THE INDEXING RULE IS THE WHOLE DESIGN ───────────────────────────────────
//
// Only a page with a resolved name is indexable. Everything else renders for a
// human and carries noindex. This is not caution, it is the difference between
// the surface ranking and dragging the domain down: thousands of "we do not
// know this code yet" pages is textbook thin content. The same judgement is
// already in this repo — cert/[id].ts noindexes a certificate with no garment
// photo for exactly this reason (US-1665 AC4).
//
// The flag itself comes from the edge (`indexable`), not from a second opinion
// computed here, so the page and sitemap-style-codes.xml cannot disagree about
// which URLs exist.
//
// The body builders are pure and exported, so what a reseller reads is a test
// rather than a screenshot.

import { escape, type BreadcrumbItem } from "./blog-render";

/** Mirrors PublicStyleCode in services/edge-functions/src/lib/public-style-code.ts. */
export interface PublicStyleCode {
  code: string;
  requested: string;
  canonical: boolean;
  brand: string;
  name: string | null;
  source: "official" | "admin" | "seller" | "consensus" | null;
  supporting: number | null;
  evidenceUrl: string | null;
  decoded: {
    gender: string | null;
    season: string | null;
    year: string | null;
    decoderKind: string;
  } | null;
  indexable: boolean;
}

/** How a source reads to someone who has never seen our vocabulary. Duplicated
 *  from the edge module deliberately: this file cannot import Deno code, and
 *  a test asserts the two lists stay in step. */
export function sourceLabel(source: PublicStyleCode["source"]): string | null {
  switch (source) {
    case "official":
      return "Lululemon's own product name";
    case "admin":
      return "Confirmed by GradeThread";
    case "seller":
      return "Corrected by a seller holding the garment";
    case "consensus":
      return "Agreed across marketplace listings";
    default:
      return null;
  }
}

/** How many confirmations, said in words rather than as a raw count. */
export function supportText(payload: PublicStyleCode): string | null {
  if (!payload.name || payload.supporting == null) return null;
  if (payload.source === "official") return "Published by the brand.";
  if (payload.source === "admin") return "Checked by hand.";
  if (payload.source === "seller") {
    return "Told to us by someone holding the garment.";
  }
  const n = payload.supporting;
  return n === 1
    ? "Seen on one marketplace listing so far."
    : `Agreed across ${n} marketplace listings.`;
}

/** The <title>. Names the product when we know it, the code when we do not. */
export function pageTitle(payload: PublicStyleCode): string {
  return payload.name
    ? `${payload.name} — ${payload.brand} ${payload.code} | GradeThread`
    : `${payload.brand} style code ${payload.code} | GradeThread`;
}

/** The meta description. Never claims to know a name we do not have. */
export function pageDescription(payload: PublicStyleCode): string {
  if (payload.name) {
    const support = supportText(payload);
    return `${payload.brand} style code ${payload.code} is the ${payload.name}. ${
      support ?? ""
    }`.trim();
  }
  const gender = payload.decoded?.gender;
  return gender
    ? `${payload.brand} style code ${payload.code} is a ${gender.toLowerCase()}'s garment. We have not confirmed the product name yet.`
    : `${payload.brand} style code ${payload.code}. We have not confirmed the product name yet.`;
}

/**
 * ProductModel JSON-LD, and ONLY when a name exists.
 *
 * No offers, no rating, no price: this page carries none of those, and the
 * repo's SEO rule (US-291..309) is that markup never describes data we do not
 * have. ProductModel rather than Product for the same reason — the page is a
 * specification of a model, not a thing for sale.
 */
export function styleCodeLd(payload: PublicStyleCode, url: string): unknown | null {
  if (!payload.name) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ProductModel",
    name: payload.name,
    productID: payload.code,
    brand: { "@type": "Brand", name: payload.brand },
    url,
    ...(payload.decoded?.gender
      ? { audience: { "@type": "PeopleAudience", suggestedGender: payload.decoded.gender } }
      : {}),
  };
}

export function breadcrumbTrail(payload: PublicStyleCode, site: string): BreadcrumbItem[] {
  return [
    { name: "Home", url: site },
    { name: "Lululemon style codes", url: `${site}/style` },
    { name: payload.code, url: `${site}/style/${payload.code}` },
  ];
}

/** One labelled fact. Empty string when there is nothing to say, so a caller
 *  can join without threading conditionals through the markup. */
function fact(label: string, value: string | null | undefined): string {
  if (!value) return "";
  return `<div class="fact"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
}

/** The page body. Pure. */
export function renderStyleCodeBody(payload: PublicStyleCode): string {
  const decoded = payload.decoded;
  const facts = [
    fact("Style code", payload.code),
    fact("Brand", payload.brand),
    fact("Made for", decoded?.gender),
    fact(
      "Season",
      decoded?.season && decoded?.year
        ? `${decoded.season} ${decoded.year}`
        : decoded?.season ?? null,
    ),
  ].join("");

  const answer = payload.name
    ? `<h1>${escape(payload.name)}</h1>
       <p class="lede">${escape(payload.brand)} style code <strong>${escape(payload.code)}</strong>.</p>
       <p class="provenance">${escape(sourceLabel(payload.source) ?? "")}. ${
      escape(supportText(payload) ?? "")
    }</p>`
    // The honest blank. It says what we DO know, which is more than nothing,
    // and it asks the one person in the world holding the garment (US-2749).
    : `<h1>${escape(payload.brand)} style code ${escape(payload.code)}</h1>
       <p class="lede">We have not confirmed this product's name yet.</p>
       <p>${
      decoded?.gender
        ? `The code tells us it is a ${escape(decoded.gender.toLowerCase())}'s garment.`
        : "The code did not decode to anything we can read."
    } If you are holding it, you know more than we do.</p>
       <p class="tell"><a href="/style?code=${
      encodeURIComponent(payload.code)
    }&amp;tell=1">Tell us what this one is &rarr;</a></p>`;

  const evidence = payload.evidenceUrl
    ? `<p class="evidence"><a href="${escape(payload.evidenceUrl)}" rel="nofollow noopener" target="_blank">See a listing that confirmed it</a></p>`
    : "";

  return `<article class="style-code">
  ${answer}
  <dl class="facts">${facts}</dl>
  ${evidence}
  <p class="where">The style code is printed inside the small circle in the pocket, waistband or neckband — the size dot. It is six characters starting with W or M, sometimes with an L in front.</p>
</article>`;
}
