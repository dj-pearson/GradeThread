// US-2957: the listing description as an ordered list of named blocks (PURE).
//
// WHY THIS EXISTS. The description was one opaque string, so the same fact
// could sit in the AI prose, in the marker-delimited measurements block and in
// the facts block at once, and only the last two could ever be updated. A
// seller who corrected a measurement was left with prose advertising the old
// number, and the only way to clear it was a full AI rewrite that threw away
// every other edit they had made.
//
// THE SPLIT THAT FIXES IT. A block either STORES text or DERIVES it. `intro`,
// `features`, `condition`, `text` and `snippet` store; `attributes`,
// `measurements`, `grade`, `disclosure`, `credentials` and `facts` derive, from
// the item row, the grade report and the seller profile. A derived block cannot
// drift from the field it shows because it has nothing of its own to drift.
//
// THE SEPARATOR IS PART OF THE BLOCK. `sep` holds the exact bytes that precede
// a block. A fresh render uses the default "\n\n"; a legacy parse records what
// was really there. Without it, convert-on-open could not be byte-exact — the
// live descriptions in the wild have a single newline before the credential
// block and three before the measurements block, and normalising that would
// silently rewrite every listing a seller merely OPENED.
//
// NOTHING HERE DOES I/O. The caller loads the item, grade, credential and
// snippets and passes them in. That is what makes the whole thing unit-testable
// and what keeps one renderer authoritative for web, iOS and Android.
//
// Design: docs/superpowers/specs/2026-08-27-modular-listing-descriptions-design.md

import {
  buildMeasurementsBlock,
  type LengthUnit,
  MEASUREMENTS_BLOCK_END,
  MEASUREMENTS_BLOCK_START,
  type Measurements,
} from "./measurements.ts";
import {
  buildSellerCredentialBlock,
  findSellerCredentialBlock,
  type SellerCredential,
  SELLER_CREDENTIALS_MARKER,
} from "./seller-credentials.ts";
import { buildDisclosure, type DisclosureInput } from "./disclosure.ts";
import {
  buildListingFactsBlock,
  disclosedFlawsToFacts,
  FACTS_MARKER_END,
  FACTS_MARKER_START,
  type FactsGradeFactor,
  measurementsToFacts,
} from "./listing-facts-block.ts";

/**
 * The disclosure block's marker. It has always been an inline literal in
 * ai-listing.ts; naming it here is what lets the parser find it.
 */
export const DISCLOSURE_MARKER = "<!--gradethread-disclosure-->";

// ─── The block ─────────────────────────────────────────────────────

export type DescriptionBlockKey =
  | "intro"
  | "features"
  | "condition"
  | "attributes"
  | "measurements"
  | "grade"
  | "disclosure"
  | "credentials"
  | "facts"
  | "snippet"
  | "text";

export type DescriptionBlockSource =
  | "ai"
  | "item"
  | "grade"
  | "seller"
  | "system"
  | "account"
  | "user";

export interface DescriptionBlock {
  key: DescriptionBlockKey;
  /** Off blocks keep their position, so toggling back on restores the order. */
  on: boolean;
  src: DescriptionBlockSource;
  /** Stored content. On `snippet` it OVERRIDES the referenced body. */
  text?: string | null;
  /** `attributes` only: which item fields to show, in order. */
  fields?: string[];
  /** `measurements` only: the unit to render (US-648). */
  unit?: LengthUnit;
  /** `snippet` only: the listing_snippets id this block renders. */
  ref?: string | null;
  /**
   * The exact bytes that precede this block in the output. Defaults to "\n\n".
   * Ignored on the first block that renders anything.
   */
  sep?: string;
}

/** Everything a render needs, already loaded. This module fetches nothing. */
export interface RenderContext {
  item: {
    brand?: string | null;
    size?: string | null;
    color?: string | null;
    material?: string | null;
    style?: string | null;
    measurements?: Measurements;
  };
  grade:
    | {
      overall_score: number | null;
      factors: FactsGradeFactor[];
      disclosure: DisclosureInput | null;
    }
    | null;
  credential: SellerCredential | null;
  /** listing_snippets id -> body. */
  snippets: Record<string, string>;
  unit: LengthUnit;
  /** US-1578: the values came from a calibrated MeasureCard photo. */
  calibrated?: boolean;
  /** Disclosed flaws for the facts block, usually the condition description. */
  conditionDescription?: string | null;
}

const DEFAULT_SEP = "\n\n";

/** Which item fields the attributes block shows when nothing says otherwise. */
export const DEFAULT_ATTRIBUTE_FIELDS = ["brand", "size", "color", "material"];

const ATTRIBUTE_LABELS: Record<string, string> = {
  brand: "Brand",
  size: "Size",
  color: "Color",
  material: "Material",
  style: "Style",
};

// ─── Rendering ─────────────────────────────────────────────────────

function renderAttributes(block: DescriptionBlock, ctx: RenderContext): string {
  const fields = block.fields?.length ? block.fields : DEFAULT_ATTRIBUTE_FIELDS;
  const lines: string[] = [];
  for (const field of fields) {
    const raw = (ctx.item as Record<string, unknown>)[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    lines.push(`- ${ATTRIBUTE_LABELS[field] ?? titleCase(field)}: ${value}`);
  }
  return lines.join("\n");
}

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The grade line, in the exact phrasing publish keys on.
 *
 * flipdesk-ebay.ts appendCertNumber finds this line by the words "Condition
 * Grade" and appends the certificate number to it. Rewording it here would
 * leave publish appending a second line instead of extending this one.
 *
 * No URL, ever: eBay treats an off-eBay link in a description as offering to
 * trade outside eBay and hides the listing.
 */
function renderGrade(ctx: RenderContext): string {
  const score = ctx.grade?.overall_score;
  if (score == null || !Number.isFinite(score)) return "";
  return `Graded by GradeThread — Condition Grade ${score.toFixed(1)}`;
}

function renderFacts(ctx: RenderContext): string {
  const { html } = buildListingFactsBlock({
    grade: ctx.grade?.overall_score ?? null,
    factors: ctx.grade?.factors ?? [],
    measurements: measurementsToFacts(
      (ctx.item.measurements ?? null) as Record<string, unknown> | null,
    ),
    fibreContent: ctx.item.material ?? null,
    flaws: disclosedFlawsToFacts(ctx.conditionDescription),
  });
  return html;
}

/** One block's content, with no separator. "" means it contributes nothing. */
export function renderBlock(block: DescriptionBlock, ctx: RenderContext): string {
  switch (block.key) {
    case "intro":
    case "features":
    case "condition":
    case "text":
      return (block.text ?? "").trim();

    case "snippet": {
      // The per-listing override wins over the account body, which is what
      // makes "same standing line everywhere, except on this one" possible.
      const own = block.text?.trim();
      if (own) return own;
      const ref = block.ref;
      if (!ref) return "";
      return (ctx.snippets[ref] ?? "").trim();
    }

    case "attributes":
      return renderAttributes(block, ctx);

    case "measurements":
      return buildMeasurementsBlock(
        ctx.item.measurements,
        block.unit ?? ctx.unit,
        { calibrated: ctx.calibrated },
      );

    case "grade":
      return renderGrade(ctx);

    case "disclosure": {
      const input = ctx.grade?.disclosure;
      if (!input) return "";
      return `${DISCLOSURE_MARKER}${buildDisclosure(input).html}`;
    }

    case "credentials": {
      if (!ctx.credential) return "";
      const { html } = buildSellerCredentialBlock(ctx.credential);
      return `${SELLER_CREDENTIALS_MARKER}${html}`;
    }

    case "facts":
      return renderFacts(ctx);
  }
}

/**
 * Render the whole description.
 *
 * Order is array order with ONE exception: the facts block is always emitted
 * last. US-2682 needs it at a fixed position so that a revise on a live listing
 * REPLACES it rather than accumulating a second copy, and a client that
 * reordered it would otherwise break that quietly.
 */
export function renderDescription(
  blocks: DescriptionBlock[],
  ctx: RenderContext,
): string {
  const ordered = [
    ...blocks.filter((b) => b.key !== "facts"),
    ...blocks.filter((b) => b.key === "facts"),
  ];

  let out = "";
  let first = true;
  for (const block of ordered) {
    if (!block.on) continue;
    const content = renderBlock(block, ctx);
    // An empty block contributes no content AND no separator, so an item with
    // no measurements does not leave a gap where the block used to be.
    if (!content) continue;
    if (first) {
      // Only the array's own first block keeps its separator, which is how
      // leading whitespace on a parsed legacy description survives. A block
      // promoted to first because the ones above it were switched off starts
      // clean instead of dragging three newlines to the top.
      out += (block === ordered[0] ? block.sep ?? "" : "") + content;
      first = false;
    } else {
      out += (block.sep ?? DEFAULT_SEP) + content;
    }
  }
  return out;
}

/** The starting order for a newly generated listing. */
export function defaultBlocks(): DescriptionBlock[] {
  return [
    { key: "intro", on: true, src: "ai", text: "" },
    { key: "features", on: true, src: "ai", text: "" },
    { key: "attributes", on: true, src: "item", fields: [...DEFAULT_ATTRIBUTE_FIELDS] },
    { key: "condition", on: true, src: "ai", text: "" },
    { key: "measurements", on: true, src: "item" },
    { key: "grade", on: false, src: "grade" },
    { key: "disclosure", on: true, src: "grade" },
    { key: "credentials", on: true, src: "seller" },
    { key: "facts", on: true, src: "system" },
  ];
}

// ─── Reading a legacy description back ─────────────────────────────

interface Region {
  key: DescriptionBlockKey;
  src: DescriptionBlockSource;
  start: number;
  end: number;
}

/** Locate a paired-marker block, e.g. measurements or facts. */
function pairedRegion(
  description: string,
  startMarker: string,
  endMarker: string,
  key: DescriptionBlockKey,
  src: DescriptionBlockSource,
): Region | null {
  const start = description.indexOf(startMarker);
  if (start < 0) return null;
  const endAt = description.indexOf(endMarker, start);
  // An opening marker with no closing one is a shape we do not recognise, and
  // the only safe response to that is to leave the description entirely alone.
  if (endAt < 0) return null;
  return { key, src, start, end: endAt + endMarker.length };
}

/** Locate a marker-then-one-div block, e.g. disclosure or credentials. */
function divRegion(
  description: string,
  marker: string,
  key: DescriptionBlockKey,
  src: DescriptionBlockSource,
): Region | null {
  const markerAt = description.indexOf(marker);
  if (markerAt < 0) return null;
  const span = findSellerCredentialBlock(description, marker);
  if (!span) return null;
  return { key, src, start: markerAt, end: span.end };
}

/**
 * Split a legacy description into blocks.
 *
 * Every byte survives. Text between recognised marker regions becomes a `text`
 * block, and the whitespace that separated two blocks is moved onto the second
 * one as `sep`, so re-rendering reproduces the original spacing exactly.
 *
 * An opening marker with no close, or a credential marker followed by something
 * that is not a `<div>`, means we do not recognise the shape — the whole string
 * degrades to ONE text block. Worst case is exactly today's behaviour.
 *
 * Pass `ctx` to RECONCILE: each derived block is rendered and compared against
 * the bytes it came from, and any that does not reproduce is downgraded to a
 * verbatim `text` block. That is what makes convert-on-open safe on a listing
 * whose stored measurements have since drifted from what the description says.
 * Without `ctx` the parse is optimistic and the caller must reconcile itself.
 */
export function parseLegacyDescription(
  description: string | null | undefined,
  ctx?: RenderContext,
): DescriptionBlock[] {
  const base = description ?? "";
  if (!base) return [];

  const candidates: Array<Region | null> = [
    pairedRegion(
      base,
      MEASUREMENTS_BLOCK_START,
      MEASUREMENTS_BLOCK_END,
      "measurements",
      "item",
    ),
    pairedRegion(base, FACTS_MARKER_START, FACTS_MARKER_END, "facts", "system"),
    divRegion(base, DISCLOSURE_MARKER, "disclosure", "grade"),
    divRegion(base, SELLER_CREDENTIALS_MARKER, "credentials", "seller"),
  ];

  // A marker that is present but unparseable means the whole description is a
  // shape we do not recognise. Degrade rather than guess.
  const unrecognised =
    (base.includes(MEASUREMENTS_BLOCK_START) && !candidates[0]) ||
    (base.includes(FACTS_MARKER_START) && !candidates[1]) ||
    (base.includes(DISCLOSURE_MARKER) && !candidates[2]) ||
    (base.includes(SELLER_CREDENTIALS_MARKER) && !candidates[3]);

  const regions = candidates
    .filter((r): r is Region => r !== null)
    .sort((a, b) => a.start - b.start);

  if (unrecognised || regions.length === 0 || overlaps(regions)) {
    return [{ key: "text", on: true, src: "user", text: base }];
  }

  const blocks: DescriptionBlock[] = [];
  // Whitespace carried from the end of one segment to the front of the next
  // block, so that re-rendering reproduces the original spacing.
  let carry = "";
  let cursor = 0;

  const pushText = (raw: string) => {
    if (!raw) return;
    const body = raw.replace(/\s+$/, "");
    if (body) {
      blocks.push({ key: "text", on: true, src: "user", text: body, sep: carry });
      carry = "";
    }
    carry += raw.slice(body.length);
  };

  for (const region of regions) {
    pushText(base.slice(cursor, region.start));
    blocks.push({ key: region.key, on: true, src: region.src, sep: carry });
    carry = "";
    cursor = region.end;
  }
  pushText(base.slice(cursor));

  return ctx ? reconcile(blocks, base, regions, ctx) : blocks;
}

function overlaps(regions: Region[]): boolean {
  for (let i = 1; i < regions.length; i++) {
    if (regions[i].start < regions[i - 1].end) return true;
  }
  return false;
}

/**
 * Downgrade any derived block that does not reproduce the bytes it came from.
 *
 * This is the guarantee behind convert-on-open: opening a listing can show a
 * live, field-backed block ONLY when doing so changes nothing. Otherwise the
 * seller sees their original text and decides for themselves.
 */
function reconcile(
  blocks: DescriptionBlock[],
  original: string,
  regions: Region[],
  ctx: RenderContext,
): DescriptionBlock[] {
  let i = 0;
  return blocks.map((block) => {
    if (block.key === "text") return block;
    const region = regions[i++];
    if (!region) return block;
    const raw = original.slice(region.start, region.end);
    return renderBlock(block, ctx) === raw
      ? block
      : { key: "text", on: true, src: "user", text: raw, sep: block.sep };
  });
}

// ─── Keeping restated facts out of the AI blocks ───────────────────

/**
 * A line that restates a fact a derived block already carries.
 *
 * Whole lines only. A sentence like "Runs true to size" is prose a seller wants
 * and a scrubber that cut inside a line would maim it; the thing worth removing
 * is the labelled bullet, which is exactly what the old prompt asked the model
 * to write and exactly what nothing could later update.
 */
const RESTATED_FACT_RE =
  /^\s*[-*•]?\s*(brand|size|color|colour|material|fabric|fiber|fibre|condition|measurements?)\b[^:\n]{0,40}:\s*\S/i;

/**
 * Strip restated facts from AI-written block text.
 *
 * Returns the text with those lines removed and the blank-line runs they leave
 * behind collapsed. Callers log the difference — if this is doing the work, the
 * prompt is not.
 */
export function scrubRestatedFacts(
  text: string | null | undefined,
  _ctx: RenderContext,
): string {
  const base = text ?? "";
  if (!base.trim()) return "";
  const kept = base
    .split(/\r?\n/)
    .filter((line) => !RESTATED_FACT_RE.test(line));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
