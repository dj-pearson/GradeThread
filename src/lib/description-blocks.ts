// US-2960: the composer's side of the description block list.
//
// The RENDERER is edge-only by design (decision 6 of the epic's design doc), so
// nothing here turns blocks into a description. What lives here is the part the
// browser owns: what a row is called, whether it can be dragged, whether it can
// be edited in place, and the two array operations the list performs — toggle
// and reorder. All pure, so the list's behaviour is testable without mounting a
// page that needs Supabase, a query client and seven hooks.
//
// Design: docs/superpowers/specs/2026-08-27-modular-listing-descriptions-design.md

import type {
  DescriptionBlock,
  DescriptionBlockKey,
  DescriptionBlockSource,
} from "@/types/database";

/** Row heading per block type. */
export const BLOCK_LABELS: Record<DescriptionBlockKey, string> = {
  intro: "Intro",
  features: "Features",
  condition: "Condition",
  attributes: "Attributes",
  measurements: "Measurements",
  grade: "Grade badge",
  disclosure: "Grade disclosure",
  credentials: "Verified seller",
  facts: "Item facts",
  snippet: "Saved snippet",
  text: "Custom text",
};

/** The small plain-text tag that says who owns a row's content. */
export const SOURCE_LABELS: Record<DescriptionBlockSource, string> = {
  ai: "AI",
  item: "Item",
  grade: "Grade",
  seller: "Seller",
  system: "System",
  account: "Account",
  user: "You",
};

/**
 * Rows that hold their position and carry no drag handle.
 *
 * `facts` is pinned because US-2682 needs it last so a revise on a live listing
 * REPLACES it rather than accumulating a second copy — the renderer moves it
 * last regardless, and a draggable row that silently snaps back is worse than
 * one that never moved. `credentials` is server-gated: the seller cannot edit
 * its content, and its position next to the facts block is what the existing
 * credentials-refresh cron expects to find.
 */
export const PINNED_KEYS: readonly DescriptionBlockKey[] = ["credentials", "facts"];

export function isPinned(key: DescriptionBlockKey): boolean {
  return PINNED_KEYS.includes(key);
}

/** Blocks whose text the seller types. Everything else is derived. */
export const EDITABLE_KEYS: readonly DescriptionBlockKey[] = [
  "intro",
  "features",
  "condition",
  "snippet",
  "text",
];

export function isEditable(key: DescriptionBlockKey): boolean {
  return EDITABLE_KEYS.includes(key);
}

/** The three blocks the AI writes, and the only ones /regenerate will touch. */
export const REGENERABLE_KEYS: readonly DescriptionBlockKey[] = [
  "intro",
  "features",
  "condition",
];

export function isRegenerable(key: DescriptionBlockKey): boolean {
  return REGENERABLE_KEYS.includes(key);
}

/**
 * The composer anchor a derived row sends the seller to.
 *
 * A derived block has nothing of its own to edit — the fix is the field it
 * reads. Ids match COMPOSER_FOCUS_ANCHORS (src/lib/publish-blockers.ts) and the
 * markup guard in src/lib/__tests__/composer-anchors.test.ts covers them.
 */
const BLOCK_ANCHORS: Partial<Record<DescriptionBlockKey, string>> = {
  attributes: "composer-category",
  measurements: "composer-measurements",
  grade: "composer-grading",
  disclosure: "composer-grading",
};

export function anchorForBlock(key: DescriptionBlockKey): string | null {
  return BLOCK_ANCHORS[key] ?? null;
}

// ─── Array operations ──────────────────────────────────────────────

/**
 * Flip one row on or off.
 *
 * The block keeps its index. That is the whole contract: a seller who switches
 * measurements off, reorders nothing, and switches it back on gets it back
 * where it was rather than at the bottom.
 */
export function toggleBlockAt(
  blocks: DescriptionBlock[],
  index: number,
): DescriptionBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  return blocks.map((b, i) => (i === index ? { ...b, on: !b.on } : b));
}

/** Set the stored text of one row, leaving every other entry by reference. */
export function setBlockTextAt(
  blocks: DescriptionBlock[],
  index: number,
  text: string,
): DescriptionBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  return blocks.map((b, i) => (i === index ? { ...b, text } : b));
}

function moveWithin<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  const taken = out.splice(from, 1);
  out.splice(to, 0, ...taken);
  return out;
}

/**
 * Reorder by drag, with the pinned rows nailed to the indices they hold.
 *
 * A plain arrayMove would slide a pinned row up by one whenever a drag crossed
 * it, which is exactly the accumulate-a-second-facts-block failure US-2682
 * fixed. So the movable rows are lifted out, moved among themselves, and the
 * pinned ones are put back at their original indices. A drag that starts or
 * ends on a pinned row is refused outright.
 */
export function moveBlock(
  blocks: DescriptionBlock[],
  from: number,
  to: number,
): DescriptionBlock[] {
  if (from === to) return blocks;
  if (from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) {
    return blocks;
  }
  const source = blocks[from];
  const target = blocks[to];
  if (!source || !target) return blocks;
  if (isPinned(source.key) || isPinned(target.key)) return blocks;

  const pinned: [number, DescriptionBlock][] = [];
  const movable: DescriptionBlock[] = [];
  blocks.forEach((b, i) => {
    if (isPinned(b.key)) pinned.push([i, b]);
    else movable.push(b);
  });

  const mFrom = movable.indexOf(source);
  const mTo = movable.indexOf(target);
  if (mFrom < 0 || mTo < 0) return blocks;

  const out = moveWithin(movable, mFrom, mTo);
  for (const [i, b] of pinned) out.splice(i, 0, b);
  return out;
}

/**
 * Put a snippet block into the array, above the pinned rows.
 *
 * Above them because `credentials` and `facts` close the description and stay
 * where they are; a new section dropped after `facts` would be moved back by
 * the renderer anyway, and the row would appear to land somewhere it did not.
 *
 * The block stores ONLY the ref. That is the whole point of snippets: the body
 * lives on the account, so editing it there changes every listing pointing at
 * it, with no write to any listing row.
 */
export function addSnippetBlock(
  blocks: DescriptionBlock[],
  ref: string,
): DescriptionBlock[] {
  const block: DescriptionBlock = { key: "snippet", on: true, src: "account", ref };
  const firstPinned = blocks.findIndex((b) => isPinned(b.key));
  if (firstPinned < 0) return [...blocks, block];
  return [...blocks.slice(0, firstPinned), block, ...blocks.slice(firstPinned)];
}

/** Drop the row at `index`. Only ever offered on rows the seller added. */
export function removeBlockAt(
  blocks: DescriptionBlock[],
  index: number,
): DescriptionBlock[] {
  if (index < 0 || index >= blocks.length) return blocks;
  return blocks.filter((_, i) => i !== index);
}

// ─── Whole-string writers ──────────────────────────────────────────

/**
 * Markers the edge renderer emits. A whole-description string that already
 * carries one has to be stripped before it becomes block text, or the block
 * that owns that section would print it a second time.
 */
const MARKER_SECTIONS: [string, string][] = [
  ["<!--gradethread-measurements-->", "<!--/gradethread-measurements-->"],
  ["<!--gradethread-facts-->", "<!--/gradethread-facts-->"],
];
const OPEN_ONLY_MARKERS = [
  "<!--gradethread-disclosure-->",
  "<!--gradethread-seller-credentials-->",
];

/**
 * Strip every rendered block out of a whole-description string, leaving prose.
 *
 * The open-only markers (disclosure, seller credentials) have no closing tag —
 * they run to the end of the string or to the next marker — so everything from
 * the first one onward is dropped.
 */
export function stripRenderedBlocks(text: string): string {
  let out = text;
  for (const [start, end] of MARKER_SECTIONS) {
    for (;;) {
      const a = out.indexOf(start);
      if (a < 0) break;
      const b = out.indexOf(end, a);
      out = b < 0 ? out.slice(0, a) : out.slice(0, a) + out.slice(b + end.length);
    }
  }
  for (const marker of OPEN_ONLY_MARKERS) {
    const at = out.indexOf(marker);
    if (at >= 0) out = out.slice(0, at);
  }
  return out.trim();
}

/**
 * Fold a whole-description string into the block array.
 *
 * The garment template, the saved-template picker and the AI rewrite each
 * produce ONE string standing for the entire prose part of a description. Blocks
 * are the source of truth now, so that string has to land in a block or the next
 * save renders it away. It goes into `intro`, and `features` and `condition` are
 * CLEARED: the string already says whatever those two would have, and leaving
 * them would print the same prose twice.
 *
 * Derived rows are untouched — that is the point of the split. A template that
 * restated the brand loses the restatement to `stripRenderedBlocks` plus the
 * attributes row that owns it.
 */
export function applyWholeText(
  blocks: DescriptionBlock[],
  text: string,
): DescriptionBlock[] {
  const prose = stripRenderedBlocks(text);
  let seenIntro = false;
  const out = blocks.map((b) => {
    if (b.key === "intro" && !seenIntro) {
      seenIntro = true;
      return { ...b, on: true, text: prose };
    }
    if (b.key === "features" || b.key === "condition") return { ...b, text: "" };
    return b;
  });
  if (!seenIntro) {
    out.unshift({ key: "intro", on: true, src: "ai", text: prose });
  }
  return out;
}

// ─── Row summaries ─────────────────────────────────────────────────

export interface BlockRowContext {
  /** Item columns the attributes row can show, in the block's `fields` order. */
  attributes: Record<string, string | null | undefined>;
  /** How many measurement values the item actually holds. */
  measurementCount: number;
  unit: "in" | "cm";
  gradeValue: number | null;
  /** listing_snippets id -> name, for the snippet row's heading. */
  snippetNames: Record<string, string>;
  /**
   * Whether `snippetNames` has actually been fetched.
   *
   * A ref missing from a list that has not loaded is NOT a deleted snippet, and
   * saying so would put "deleted, renders nothing" under a perfectly good
   * section for as long as the request takes.
   */
  snippetsLoaded?: boolean;
}

const UNIT_WORDS: Record<"in" | "cm", string> = {
  in: "inches",
  cm: "centimetres",
};

/**
 * The one-line summary shown on a row.
 *
 * Derived rows say what they will show rather than showing it, because the row
 * is a control and the preview panel below is where the actual bytes live.
 */
export function describeBlock(
  block: DescriptionBlock,
  ctx: BlockRowContext,
): string {
  switch (block.key) {
    case "intro":
    case "features":
    case "condition":
    case "text":
      return (block.text ?? "").trim() || "Empty";

    case "snippet": {
      // The per-listing override wins, exactly as the renderer resolves it —
      // which is why an override survives the snippet it overrides being
      // renamed, edited or deleted.
      const own = (block.text ?? "").trim();
      if (own) return own;
      const ref = block.ref;
      if (!ref) return "Empty";
      const name = ctx.snippetNames[ref];
      if (name) return name;
      // Deleting a snippet leaves the block in place and renders nothing, which
      // is the safe outcome and an invisible one. The row is where it gets said.
      return ctx.snippetsLoaded
        ? "Deleted snippet, so this section shows nothing"
        : "Saved snippet";
    }

    case "attributes": {
      const fields = block.fields ?? ["brand", "size", "color", "material"];
      const filled = fields.filter((f) => String(ctx.attributes[f] ?? "").trim());
      if (filled.length === 0) return "No attributes filled in yet";
      return filled.map(attributeLabel).join(", ");
    }

    case "measurements": {
      if (ctx.measurementCount === 0) return "No measurements yet";
      const unit = block.unit ?? ctx.unit;
      const n = ctx.measurementCount;
      return `${n} ${n === 1 ? "value" : "values"}, ${UNIT_WORDS[unit]}`;
    }

    case "grade":
      return ctx.gradeValue == null
        ? "Not graded yet"
        : `${ctx.gradeValue.toFixed(1)} / 10`;

    case "disclosure":
      return ctx.gradeValue == null
        ? "Not graded yet"
        : "Defects and grade disclosure from the report";

    case "credentials":
      // The server decides whether this seller has one and what it says, so the
      // row promises the section rather than previewing bytes it cannot know.
      return "Your verified-seller stats, filled in by the server";

    case "facts":
      return "Machine-readable facts, always last";
  }
}

const ATTRIBUTE_LABELS: Record<string, string> = {
  brand: "Brand",
  size: "Size",
  color: "Color",
  material: "Material",
  style: "Style",
};

function attributeLabel(field: string): string {
  return ATTRIBUTE_LABELS[field] ?? field;
}

export type { DescriptionBlock, DescriptionBlockKey, DescriptionBlockSource };

/**
 * The starting order for a listing that has no row yet.
 *
 * Mirrors `defaultBlocks()` in services/edge-functions/src/lib/
 * description-blocks.ts, which is authoritative — this copy exists only so the
 * composer can show rows before the first save, when there is no listing id to
 * ask the server about. Frozen because the hook holds it by identity.
 */
export const DEFAULT_DESCRIPTION_BLOCKS: readonly DescriptionBlock[] = Object.freeze([
  { key: "intro", on: true, src: "ai", text: "" },
  { key: "features", on: true, src: "ai", text: "" },
  { key: "attributes", on: true, src: "item", fields: ["brand", "size", "color", "material"] },
  { key: "condition", on: true, src: "ai", text: "" },
  { key: "measurements", on: true, src: "item" },
  { key: "grade", on: false, src: "grade" },
  { key: "disclosure", on: true, src: "grade" },
  { key: "credentials", on: true, src: "seller" },
  { key: "facts", on: true, src: "system" },
] as DescriptionBlock[]);
