// US-551: AI-vs-edited diff helpers for AutoLister drafts.
//
// The AI's original draft is snapshotted on the listing row as
// `ai_generated_snapshot` (jsonb, written in ai-listing.ts at generation time).
// It stays immutable while the seller edits the live columns, so the composer
// and the bulk grid can show exactly what changed from the AI and offer a
// per-field revert-to-AI. These helpers normalize values for change detection
// and format AI originals for the diff chips.

import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";
import type { ListingAiSnapshot } from "@/types/database";

export type { ListingAiSnapshot };

// Normalize a text value for change-detection: trim, and treat null/undefined/""
// as the same empty value (an edit from "" to "" isn't a change).
export function normalizeText(v: string | null | undefined): string {
  return (v ?? "").trim();
}

// True when the seller's current value differs from the AI's original. When the
// AI never produced a value for the field (empty original) there's nothing to
// diff against, so it's never flagged as changed.
export function textChanged(
  ai: string | null | undefined,
  current: string | null | undefined,
): boolean {
  const a = normalizeText(ai);
  if (a === "") return false;
  return a !== normalizeText(current);
}

// Price diff works on dollar strings (the inputs are dollar-typed) compared to
// the snapshot's cents. Tolerant to formatting (42 vs 42.00).
export function priceChanged(
  aiCents: number | null | undefined,
  currentDollars: string | null | undefined,
): boolean {
  if (aiCents == null) return false;
  const cur = Number.parseFloat(currentDollars ?? "");
  if (!Number.isFinite(cur)) return true; // blank/invalid edit away from a real AI price
  return Math.round(cur * 100) !== Math.round(aiCents);
}

// Format the AI's cents price for display, e.g. 4200 -> "$42", 3850 -> "$38.50".
export function formatAiPrice(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const dollars = cents / 100;
  const fixed = dollars.toFixed(2);
  return `$${fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed}`;
}

// The dollar string a revert-to-AI should write back into a price input.
export function aiPriceInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return String(cents / 100);
}

// Map an eBay condition enum value to its human label for the diff chip.
export function conditionLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return EBAY_CONDITION_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

// Pull a single-value aspect (Department/Brand/Size/Color, …) out of the
// snapshot's item_specifics. These are stored as string arrays; the inline
// editors only edit the first value.
export function aiAspect(
  snapshot: ListingAiSnapshot | null | undefined,
  key: string,
): string {
  const arr = snapshot?.item_specifics?.[key];
  return Array.isArray(arr) ? (arr[0] ?? "") : "";
}
