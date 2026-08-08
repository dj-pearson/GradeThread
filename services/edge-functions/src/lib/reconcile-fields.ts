// Field-level reconciliation between a user's imported inventory record (the
// "original", from their spreadsheet) and the AutoLister AI-generated listing
// draft (the "AI" version). Shared by the edge reconcile endpoints so web AND
// iOS drive the exact same field set, comparison, and write-back. See the
// AutoLister review-step UX: matched by the user's own SKU, the seller picks
// per field which value reaches the final draft.

import { applyTitleSubstitution, SYNCABLE_TITLE_FIELDS } from "./title-sync.ts";

export interface ReconcileItemRow {
  id: string;
  sku: string | null;
  title: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  style: string | null;
  description: string | null;
  target_price: number | null;
}

export interface ReconcileListingRow {
  id: string;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  item_specifics_override: Record<string, string[]> | null;
}

// Where the AI value for a field lives on the generated listing draft: either a
// top-level listing column, or an entry in the item_specifics_override aspect
// map (the eBay item specifics). The original always lives on the inventory
// item column named by `itemCol`.
type AiLocation =
  | { kind: "listing_col"; col: keyof ReconcileListingRow }
  | { kind: "aspect"; aspect: string };

interface FieldSpec {
  key: string;
  label: string;
  itemCol: keyof ReconcileItemRow;
  ai: AiLocation;
  // Numeric fields (price) round-trip through Number; everything else is text.
  numeric?: boolean;
}

// Canonical reconciliation field set. Order = display order in the picker.
export const RECONCILE_FIELDS: FieldSpec[] = [
  { key: "title", label: "Title", itemCol: "title", ai: { kind: "listing_col", col: "listing_title" } },
  { key: "brand", label: "Brand", itemCol: "brand", ai: { kind: "aspect", aspect: "Brand" } },
  { key: "size", label: "Size", itemCol: "size", ai: { kind: "aspect", aspect: "Size" } },
  { key: "color", label: "Color", itemCol: "color", ai: { kind: "aspect", aspect: "Color" } },
  { key: "material", label: "Material", itemCol: "material", ai: { kind: "aspect", aspect: "Material" } },
  { key: "style", label: "Style", itemCol: "style", ai: { kind: "aspect", aspect: "Style" } },
  { key: "description", label: "Description", itemCol: "description", ai: { kind: "listing_col", col: "listing_description" } },
  { key: "price", label: "Price", itemCol: "target_price", ai: { kind: "listing_col", col: "listing_price" }, numeric: true },
];

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v).trim();
}

function readAi(listing: ReconcileListingRow, ai: AiLocation): string {
  if (ai.kind === "listing_col") return asText(listing[ai.col]);
  const arr = listing.item_specifics_override?.[ai.aspect];
  return asText(arr?.[0]);
}

export interface ReconcileFieldDiff {
  key: string;
  label: string;
  original: string;
  ai: string;
  // True when the two sides disagree AND at least one side has a value — the
  // rows the seller actually needs to decide. Equal values / both-empty are
  // surfaced too (for transparency) but flagged false.
  differs: boolean;
  // Suggested default selection: prefer the AI value when it's non-empty and
  // differs (it's the freshly-generated, listing-tuned copy); otherwise keep
  // the original. The seller can override any of these.
  suggested: "original" | "ai";
}

export function buildReconcileDiff(
  item: ReconcileItemRow,
  listing: ReconcileListingRow,
): ReconcileFieldDiff[] {
  return RECONCILE_FIELDS.map((f) => {
    const original = asText(item[f.itemCol]);
    const ai = readAi(listing, f.ai);
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const differs = norm(original) !== norm(ai) && (original !== "" || ai !== "");
    const suggested: "original" | "ai" =
      differs && ai !== "" ? "ai" : "original";
    return { key: f.key, label: f.label, original, ai, differs, suggested };
  });
}

export interface MergeWrites {
  itemUpdate: Record<string, string | number | null>;
  listingColUpdate: Record<string, string | number | null>;
  aspectUpdate: Record<string, string[]>;
}

// Resolve the seller's per-field choices into concrete writes for BOTH the
// inventory_items row (so the seller's record stays in sync) and the listing
// draft (column + aspect map, so the chosen value reaches eBay). `choices` maps
// a field key to the winning side; unspecified fields default to `suggested`.
export function buildMergeWrites(
  item: ReconcileItemRow,
  listing: ReconcileListingRow,
  choices: Record<string, "original" | "ai">,
): MergeWrites {
  const diff = buildReconcileDiff(item, listing);
  const bySuggestion = new Map(diff.map((d) => [d.key, d.suggested]));

  const itemUpdate: Record<string, string | number | null> = {};
  const listingColUpdate: Record<string, string | number | null> = {};
  const aspectUpdate: Record<string, string[]> = {
    ...(listing.item_specifics_override ?? {}),
  };

  for (const f of RECONCILE_FIELDS) {
    const choice = choices[f.key] ?? bySuggestion.get(f.key) ?? "original";
    const original = asText(item[f.itemCol]);
    const ai = readAi(listing, f.ai);
    const winnerText = choice === "ai" ? ai : original;

    // Inventory column write-back (sync the seller's record).
    if (f.numeric) {
      const n = Number.parseFloat(winnerText);
      itemUpdate[f.itemCol] = Number.isFinite(n) ? n : null;
    } else {
      itemUpdate[f.itemCol] = winnerText || null;
    }

    // Listing draft write — so the chosen value reaches the published offer.
    if (f.ai.kind === "listing_col") {
      if (f.numeric) {
        const n = Number.parseFloat(winnerText);
        listingColUpdate[f.ai.col] = Number.isFinite(n) ? n : null;
      } else {
        listingColUpdate[f.ai.col] = winnerText || null;
      }
    } else {
      if (winnerText) aspectUpdate[f.ai.aspect] = [winnerText];
      else delete aspectUpdate[f.ai.aspect];
    }
  }

  // US-1995: the title the seller kept can still name the brand they just
  // replaced.
  //
  // Every other field here is decided in isolation, but Title is not independent
  // of Brand/Size/Color/Style — it QUOTES them. Choose "original" for Title and
  // "ai" for Brand, which is the default suggestion whenever the AI read a
  // different brand off the tag, and the write lands a corrected Brand column
  // beside a title still selling the old one. The title is not ignored on this
  // path, which is why it looked handled; it is written, just never reconciled
  // against the other winners.
  //
  // applyTitleSubstitution rather than syncTitle, deliberately: syncTitle
  // re-trims to eBay's 80 characters and this path never trimmed. Silently
  // truncating a title the seller explicitly chose would be a larger change than
  // the one being fixed, and publish enforces the cap itself.
  const resolvedTitle = listingColUpdate.listing_title;
  if (typeof resolvedTitle === "string" && resolvedTitle) {
    let synced = resolvedTitle;
    for (const f of RECONCILE_FIELDS) {
      if (!(SYNCABLE_TITLE_FIELDS as readonly string[]).includes(f.key)) continue;
      const to = itemUpdate[f.itemCol];
      if (typeof to !== "string") continue;
      synced = applyTitleSubstitution(synced, asText(item[f.itemCol]), to);
    }
    if (synced !== resolvedTitle) listingColUpdate.listing_title = synced;
  }

  return { itemUpdate, listingColUpdate, aspectUpdate };
}
