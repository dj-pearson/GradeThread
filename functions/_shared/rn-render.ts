// US-9031: the public RN lookup page at /rn/:number.
//
// Someone reads a number off a care label and wants to know who made the
// garment. That search happens on somebody else's site thousands of times a
// day; this is ours, and it answers with two things they cannot show — how many
// real garment tags we have read that number off, and exactly where the company
// name came from.
//
// ── THE HONESTY RULES ARE THE DESIGN, NOT DECORATION ───────────────────────
//
// An RN names the COMPANY, never the brand and never authenticity. A counterfeit
// prints a real RN too. lib/registered-numbers.ts has held that line since
// US-2211 and this page must not soften it into a trust signal — the whole
// point of the surface is that it is checkable.
//
// A number we cannot resolve renders for a human and carries noindex, and its
// copy says we have no reference for it. It NEVER reads as the number being
// wrong, invalid or fake: "no reference" is the normal case, not a verdict.
//
// The body builders are pure and exported, so what a reader sees is a test
// rather than a screenshot.

import { escape, type BreadcrumbItem } from "./blog-render";

/** Mirrors PublicRegisteredNumber in
 *  services/edge-functions/src/lib/public-registered-number.ts. */
export interface PublicRegisteredNumber {
  key: string;
  kind: "RN" | "CA";
  digits: string;
  requested: string;
  canonical: boolean;
  companyName: string | null;
  brands: string[];
  productLines: string[];
  sourceUrl: string | null;
  sightings: number | null;
  indexable: boolean;
}

/** "RN 56323" — how the number is printed on a label and read aloud. */
export function numberLabel(payload: PublicRegisteredNumber): string {
  return `${payload.kind} ${payload.digits}`;
}

export function pageTitle(payload: PublicRegisteredNumber): string {
  return payload.companyName
    ? `${numberLabel(payload)} — ${payload.companyName} — GradeThread`
    : `${numberLabel(payload)} — registered identification number — GradeThread`;
}

/** Never names a company we do not have. */
export function pageDescription(payload: PublicRegisteredNumber): string {
  if (!payload.companyName) {
    return `${
      numberLabel(payload)
    } is a registered identification number printed on a garment label. We have no record of this one yet. An RN names the company that made or imported the item, not the brand.`;
  }
  const brands = payload.brands.length > 0
    ? ` Labels sold as ${payload.brands.join(", ")}.`
    : "";
  return `${numberLabel(payload)} is registered to ${payload.companyName}.${brands} An RN names the company that made, imported or sold the item, not the brand on the tag.`;
}

/**
 * Organization JSON-LD, and ONLY when a company is resolved.
 *
 * No rating, no offers, no claim of verification: the page carries none of
 * those, and the repo's SEO rule is that markup never describes data we do not
 * have. `identifier` carries the RN itself, which is the one fact a machine
 * reading this page should take away.
 */
export function rnLd(payload: PublicRegisteredNumber, url: string): unknown | null {
  if (!payload.companyName) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: payload.companyName,
    url,
    identifier: {
      "@type": "PropertyValue",
      propertyID: payload.kind === "RN"
        ? "US FTC Registered Identification Number"
        : "Canadian CA Identification Number",
      value: payload.digits,
    },
    ...(payload.brands.length > 0
      ? { brand: payload.brands.map((name) => ({ "@type": "Brand", name })) }
      : {}),
  };
}

export function breadcrumbTrail(
  payload: PublicRegisteredNumber,
  site: string,
): BreadcrumbItem[] {
  return [
    { name: "Home", url: site },
    { name: "RN number lookup", url: `${site}/tools/rn-lookup` },
    { name: numberLabel(payload), url: `${site}/rn/${payload.digits}` },
  ];
}

/** One labelled fact, or nothing at all. */
function fact(label: string, value: string | null | undefined): string {
  if (!value) return "";
  return `<div class="fact"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
}

/** "We have read this number off 12 real garment tags." Null below one, because
 *  "1 tag" is a boast about nothing and zero is not worth a sentence. */
export function sightingText(payload: PublicRegisteredNumber): string | null {
  const n = payload.sightings ?? 0;
  if (n < 2) return null;
  return `We have read this number off ${n} garment tags people have photographed.`;
}

/** The page body. Pure. */
export function renderRnBody(payload: PublicRegisteredNumber): string {
  const label = numberLabel(payload);

  const facts = [
    fact("Number", label),
    fact("Registered to", payload.companyName),
    fact("Brands", payload.brands.length > 0 ? payload.brands.join(", ") : null),
    fact(
      "Product lines",
      payload.productLines.length > 0 ? payload.productLines.join(", ") : null,
    ),
  ].join("");

  const answer = payload.companyName
    ? `<h1>${escape(payload.companyName)}</h1>
       <p class="lede">${escape(label)} is registered to ${escape(payload.companyName)}.</p>`
    // The honest blank. It is the common case and it means nothing bad.
    : `<h1>${escape(label)}</h1>
       <p class="lede">We have no reference for this number yet.</p>
       <p>That is not a mark against it. Most registered numbers belong to
       companies nobody has looked up, and our index fills as people scan tags.
       The number on your label is almost certainly real.</p>`;

  const brandsNote = payload.brands.length > 1
    ? `<p class="shared">One company often labels several brands, so this number
       cannot tell you which of ${
      escape(payload.brands.join(", "))
    } you are holding. It narrows it to the company, not the label.</p>`
    : "";

  const sighting = sightingText(payload);
  const sightingHtml = sighting ? `<p class="sightings">${escape(sighting)}</p>` : "";

  const source = payload.sourceUrl
    ? `<p class="evidence"><a href="${
      escape(payload.sourceUrl)
    }" rel="nofollow noopener" target="_blank">See the FTC record</a></p>`
    : "";

  return `<article class="rn-lookup">
  ${answer}
  <dl class="facts">${facts}</dl>
  ${brandsNote}
  ${sightingHtml}
  ${source}
  <h2>What this number can and cannot tell you</h2>
  <p>An RN names the company that manufactured, imported, distributed or sold
  the item. It does not name the brand on the tag, and one company can label
  many brands. It is also public, which means a counterfeit can print a real
  one. Treat a match as corroboration, never as proof.</p>
  <p class="where">The number is printed on the care label, usually next to the
  fabric content, as "RN" followed by digits. Canadian labels print "CA" and a
  different registry.</p>
  <p class="tool"><a href="/tools/rn-lookup?rn=${
    encodeURIComponent(payload.digits)
  }">Read the rest of the tag &rarr;</a> Photograph the label and we will pull
  out the size, the fabric and the style code too.</p>
</article>`;
}
