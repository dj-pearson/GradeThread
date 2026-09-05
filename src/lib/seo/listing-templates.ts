// US-3089: the copyable listing templates on /tools/listing-generator.
//
// The page ships two halves. This is the one that works with no endpoint, no
// account and no photo: a title pattern and a fill-in-the-blanks description
// for each of the four marketplaces, which is what somebody searching "ebay
// listing template" actually asked for.
//
// EVERY LIMIT AND EVERY FIELD NAME IS DERIVED FROM MARKETPLACE_SPECS, and that
// is the whole design. The incumbents on these SERPs are static HTML template
// sites from the Auctiva and inkFrog era, and the reason they are bad is not
// that they look old: it is that their numbers stopped being true years ago and
// nobody noticed, because a hand-typed "80 characters" in a paragraph has
// nothing checking it. Reading the registry means our page cannot drift from
// the thing the product itself pushes to, and a spec correction fixes the
// marketing page in the same commit.
//
// Pure data + pure functions, so it is unit-testable and prerenders in Node.

import {
  type FieldSpec,
  MARKETPLACE_SPECS,
  type MarketplacePlatform,
  type MarketplaceSpec,
} from "@/lib/marketplace-specs";

/** The four the free tool writes for, in tab order. */
export const TEMPLATE_PLATFORMS = ["ebay", "poshmark", "mercari", "depop"] as const;
export type TemplatePlatform = (typeof TEMPLATE_PLATFORMS)[number];

/** A placeholder the seller replaces. Rendered as-is inside the template. */
function slot(label: string): string {
  return `[${label}]`;
}

/**
 * The title pattern for a platform, or null when it has no title field.
 *
 * Keyword ORDER is the part worth getting right and the part every template
 * site gets wrong by putting the brand wherever it reads nicely. Search on all
 * three title-carrying platforms weights the front of the string, so the
 * pattern leads with the two words a buyer types (brand, item) and trails the
 * ones they filter by afterwards.
 */
export function titlePattern(platform: TemplatePlatform): string | null {
  const spec = MARKETPLACE_SPECS[platform];
  if (spec.titleMaxLength == null) return null;
  return [
    slot("Brand"),
    slot("Item"),
    slot("Size"),
    slot("Color"),
    slot("Material or key detail"),
  ].join(" ");
}

/** Fields the seller fills on the platform's own form, from the registry. */
export function templateFields(spec: MarketplaceSpec): FieldSpec[] {
  return spec.fields.filter((f) => f.key !== "title" && f.key !== "description");
}

/**
 * The fill-in-the-blanks description.
 *
 * Built from `spec.fields` rather than written per platform, so Poshmark's
 * "Color (up to 2)" and Depop's "Hashtags (up to 5)" appear because the
 * registry says so. A field renamed in the registry renames here.
 *
 * The CONDITION line uses the platform's own wording (spec.conditions), because
 * a Poshmark listing that says "Used - Excellent" instead of "EUC" reads as
 * written by somebody who does not sell there.
 */
export function descriptionTemplate(platform: TemplatePlatform): string {
  const spec = MARKETPLACE_SPECS[platform];
  const lines: string[] = [];

  lines.push(`${slot("One line on what it is and who it suits")}`);
  lines.push("");
  lines.push(`${slot("Two or three features a photo cannot show")}`);
  lines.push("");
  lines.push("Details");
  for (const field of templateFields(spec)) {
    if (field.key === "price" || field.key === "originalPrice") continue;
    lines.push(`- ${field.label}: ${slot(field.label)}`);
  }
  lines.push("");
  lines.push(
    `Condition: ${slot(spec.conditions.map((c) => c.value).join(" / ") || "describe it")}`,
  );
  lines.push(`${slot("Name every flaw, where it is and how big")}`);
  lines.push("");
  lines.push("Measurements, laid flat");
  lines.push(`- Chest: ${slot("in")}`);
  lines.push(`- Length: ${slot("in")}`);
  lines.push(`- Shoulder: ${slot("in")}`);
  if (spec.tags) {
    lines.push("");
    lines.push(
      `${slot(`Up to ${spec.tags.max} hashtags`)}`,
    );
  }
  return lines.join("\n");
}

/**
 * The per-platform notes worth printing beside the template.
 *
 * Derived, not typed: each one is a consequence of a registry field, so it
 * cannot say something the product does not also believe. The point is that
 * these are the four facts a seller gets wrong, and three of them are invisible
 * on the platform's own form.
 */
export function templateNotes(platform: TemplatePlatform): string[] {
  const spec = MARKETPLACE_SPECS[platform];
  const notes: string[] = [];

  if (spec.titleMaxLength == null) {
    notes.push(
      `${spec.label} has no separate title field. The first line of your ` +
        `description is what a buyer sees in the grid, so put the brand and the ` +
        `item there and nothing else.`,
    );
  } else {
    notes.push(
      `Titles are cut at ${spec.titleMaxLength} characters. Words past that are ` +
        `not shortened, they are gone, so put the ones a buyer types first.`,
    );
  }

  if (spec.descriptionMaxLength != null) {
    notes.push(
      `The description holds ${spec.descriptionMaxLength.toLocaleString("en-US")} ` +
        `characters. Measurements and flaws earn their space; a returns policy ` +
        `nobody reads does not.`,
    );
  } else {
    notes.push(
      `The description has no practical length limit on ${spec.label}. That is ` +
        `not a reason to fill it. Buyers scan for measurements and flaws, and ` +
        `both get harder to find the more boilerplate sits above them.`,
    );
  }

  if (spec.usesOwnTaxonomy) {
    notes.push(
      `Category comes from ${spec.label}'s own tree, so it has to be picked ` +
        `there rather than typed. Picking the wrong branch is the most common ` +
        `reason a listing gets no views at all.`,
    );
  }

  notes.push(`Up to ${spec.maxPhotos} photos.`);

  if (spec.priceStep === 1) {
    notes.push(
      `${spec.label} takes whole dollars only. There is no decimal point in the ` +
        `price box, so $32.49 is not a price it can hold.`,
    );
  }

  if (spec.tags) {
    notes.push(
      `Up to ${spec.tags.max} hashtag${spec.tags.max === 1 ? "" : "s"}.` +
        (spec.tags.help ? ` ${spec.tags.help}.` : ""),
    );
  }

  if (spec.brandAllowList) {
    notes.push(
      `Brand must come from ${spec.label}'s own list. A brand that is not on it ` +
        `cannot be typed in.`,
    );
  }

  return notes;
}

export interface ListingTemplate {
  platform: TemplatePlatform;
  label: string;
  /** Null when the platform has no title field. */
  titlePattern: string | null;
  titleLimit: number | null;
  descriptionTemplate: string;
  descriptionLimit: number | null;
  /** Fields the seller sets on the platform's form, from the registry. */
  fields: FieldSpec[];
  /** The platform's own condition wording, best to worst. */
  conditions: { value: string; label: string }[];
  maxPhotos: number;
  notes: string[];
}

export function listingTemplate(platform: TemplatePlatform): ListingTemplate {
  const spec = MARKETPLACE_SPECS[platform];
  return {
    platform,
    label: spec.label,
    titlePattern: titlePattern(platform),
    titleLimit: spec.titleMaxLength,
    descriptionTemplate: descriptionTemplate(platform),
    descriptionLimit: spec.descriptionMaxLength,
    fields: templateFields(spec),
    conditions: [...spec.conditions],
    maxPhotos: spec.maxPhotos,
    notes: templateNotes(platform),
  };
}

export function listingTemplates(): ListingTemplate[] {
  return TEMPLATE_PLATFORMS.map(listingTemplate);
}

/** The endpoint the photo half posts to (US-3088). */
export const LISTING_DRAFT_ENDPOINT = "/api/grading/public/listing-draft";

export const LISTING_GENERATOR_SLUG = "listing-generator";
export const LISTING_GENERATOR_PATH = `/tools/${LISTING_GENERATOR_SLUG}`;

/**
 * The free tool's per-call photo cap and hourly limit, mirrored from the edge
 * so the page can say the number before a visitor hits it.
 *
 * ⚠ These are a COPY of the edge's authority (lib/free-listing-draft.ts), not
 * the authority itself — the two live in different runtimes and cannot import
 * each other. src/lib/__tests__/listing-templates.test.ts pins them against the
 * edge source so a change there fails this build rather than quietly making the
 * page lie about a limit the visitor is about to hit.
 */
export const LISTING_DRAFT_MAX_PHOTOS = 3;
export const LISTING_DRAFT_PER_HOUR = 3;

/** A platform string the endpoint accepts, or null. */
export function asTemplatePlatform(v: string): TemplatePlatform | null {
  return (TEMPLATE_PLATFORMS as readonly string[]).includes(v) ? (v as TemplatePlatform) : null;
}

export function isTemplatePlatform(v: MarketplacePlatform): v is TemplatePlatform {
  return (TEMPLATE_PLATFORMS as readonly string[]).includes(v);
}
