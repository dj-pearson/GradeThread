// eBay standardized size values (developer notice of 2026-08; enforcement by
// site from 2026-08-31, US on 2026-09-22, all MSKU listings 2026-10-20).
//
// The symptom: a publish that worked last week answers
//   "The product aspects for this category no longer support custom values for
//    Size Type. Your listing was not published. Update your request to use our
//    standard values for Size Type. Use getItemAspectsForCategory ..."
// The cause on our side: the Taxonomy payload for the category is read-through
// cached, so an aspect eBay flipped to a closed list can still read SUGGESTED
// here, and reconcilePublishAspects passed the custom value straight through.
//
// This module is the self-heal. When eBay names an aspect this way, the
// category's cache is dropped and refetched, the stored specifics are
// reconciled against the FRESH spec (the size family is a closed list whatever
// the mode says, see aspect-reconcile.ts), the repaired map is written back to
// the draft, and the seller gets a sentence that says what changed or which
// value to pick. Pure parts first, the one async orchestration last.

import { getCategoryAspects, invalidateCategoryAspects } from "./ebay-client.ts";
import { supabaseAdmin } from "./supabase.ts";
import {
  normalizeAspectMap,
  reconcilePublishAspects,
  type ReconcileSpec,
} from "./aspect-reconcile.ts";

/** eBay's wording, in both forms seen: "custom values for X" and "standard values for X". */
const CUSTOM_VALUE_RE =
  /no longer support custom values for ([^.]+?)\.|use our standard values for ([^.]+?)\./gi;

/** The aspect names eBay refused custom values for, deduplicated, in order. */
export function parseCustomValueRejection(messages: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const hit of (m ?? "").matchAll(CUSTOM_VALUE_RE)) {
      const name = (hit[1] ?? hit[2] ?? "").trim();
      if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
  }
  return out;
}

export interface RawAspectSpec {
  localizedAspectName?: string;
  aspectConstraint?: { aspectMode?: string; aspectDataType?: string };
  aspectValues?: Array<{ localizedValue?: string }>;
}

/** The reconcile specs for a raw Taxonomy payload. */
export function reconcileSpecsFromPayload(payload: unknown): ReconcileSpec[] {
  const raw = (payload as { aspects?: unknown } | null)?.aspects;
  const list = Array.isArray(raw) ? (raw as RawAspectSpec[]) : [];
  return list
    .map((a) => ({
      name: a.localizedAspectName ?? "",
      mode: a.aspectConstraint?.aspectMode ?? "FREE_TEXT",
      allowedValues: (a.aspectValues ?? [])
        .map((v) => v.localizedValue ?? "")
        .filter((v) => v.length > 0),
      dataType: a.aspectConstraint?.aspectDataType,
    }))
    .filter((s) => s.name.length > 0);
}

export interface RefitChange {
  aspect: string;
  from: string[];
  to: string[];
}

export interface RefitUnresolved {
  aspect: string;
  value: string;
  allowedSample: string[];
  allowedCount: number;
}

export interface RefitResult {
  /** The map to persist and send next time. */
  aspects: Record<string, string[]>;
  /** Named aspects whose value was repaired to an allowed one. */
  changed: RefitChange[];
  /** Named aspects whose value matched nothing; the seller has to pick. */
  unresolved: RefitUnresolved[];
}

function loose(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Re-reconcile a stored aspect map against a fresh spec and report what
 * happened to the aspects eBay named. Pure.
 */
export function refitAspectsAfterRejection(
  stored: Record<string, unknown> | null | undefined,
  freshSpecs: ReconcileSpec[],
  namedAspects: readonly string[],
): RefitResult {
  const before = normalizeAspectMap(stored);
  const { aspects } = reconcilePublishAspects(before, freshSpecs);
  const changed: RefitChange[] = [];
  const unresolved: RefitUnresolved[] = [];
  for (const name of namedAspects) {
    const key = loose(name);
    const beforeKey = Object.keys(before).find((k) => loose(k) === key);
    const afterKey = Object.keys(aspects).find((k) => loose(k) === key);
    const spec = freshSpecs.find((s) => loose(s.name) === key);
    const from = beforeKey ? before[beforeKey] ?? [] : [];
    const to = afterKey ? aspects[afterKey] ?? [] : [];
    if (to.length > 0 && JSON.stringify(from) !== JSON.stringify(to)) {
      changed.push({ aspect: spec?.name ?? name, from, to });
    } else if (to.length === 0 && from.length > 0) {
      const allowed = spec?.allowedValues ?? [];
      unresolved.push({
        aspect: spec?.name ?? name,
        value: from[0] ?? "",
        allowedSample: allowed.slice(0, 8),
        allowedCount: allowed.length,
      });
    }
  }
  return { aspects, changed, unresolved };
}

/** The seller-facing sentence for a refit. */
export function sizeEnforcementMessage(result: Pick<RefitResult, "changed" | "unresolved">): string {
  const parts: string[] = [];
  for (const c of result.changed) {
    parts.push(
      `eBay now only accepts its standard values for ${c.aspect}. We changed "${c.from.join(", ")}" to "${c.to.join(", ")}" to match. Publish again.`,
    );
  }
  for (const u of result.unresolved) {
    const sample = u.allowedSample.length > 0
      ? ` Pick one of: ${u.allowedSample.join(", ")}${u.allowedCount > u.allowedSample.length ? ", ..." : ""}.`
      : " Pick one of eBay's values in the composer.";
    parts.push(
      `eBay now only accepts its standard values for ${u.aspect}, and "${u.value}" is not one of them.${sample}`,
    );
  }
  return parts.join(" ");
}

export interface HealInput {
  err: unknown;
  categoryId: string | null | undefined;
  itemId: string;
  /** The draft listing row the override lives on, when there is one. */
  listingId: string | null | undefined;
}

export interface HealOutcome {
  message: string;
  changed: RefitChange[];
  unresolved: RefitUnresolved[];
}

/**
 * Drop the stale spec, refetch, refit the stored specifics and persist them.
 * Returns null when the error is not a custom-value rejection, or when
 * nothing about it could be healed (the caller falls back to the usual map).
 * Never throws: a failure here must not hide the original rejection.
 */
export async function healCustomValueRejection(input: HealInput): Promise<HealOutcome | null> {
  const messages = (input.err as { ebayErrorMessages?: string[] } | null)?.ebayErrorMessages ?? [];
  const named = parseCustomValueRejection(messages);
  if (named.length === 0 || !input.categoryId) return null;
  try {
    await invalidateCategoryAspects(input.categoryId);
    const fresh = await getCategoryAspects(input.categoryId, { fresh: true });
    const specs = reconcileSpecsFromPayload(fresh.aspects);

    let stored: Record<string, unknown> | null = null;
    if (input.listingId) {
      const { data } = await supabaseAdmin
        .from("listings")
        .select("item_specifics_override")
        .eq("id", input.listingId)
        .maybeSingle();
      stored = (data as { item_specifics_override?: Record<string, unknown> | null } | null)
        ?.item_specifics_override ?? null;
    }
    if (!stored) {
      const { data } = await supabaseAdmin
        .from("inventory_items")
        .select("ebay_aspects")
        .eq("id", input.itemId)
        .maybeSingle();
      stored = (data as { ebay_aspects?: Record<string, unknown> | null } | null)?.ebay_aspects ?? null;
    }
    const refit = refitAspectsAfterRejection(stored, specs, named);
    if (refit.changed.length > 0) {
      // Persist the repaired map where the publish reads it from, so the
      // seller's next press sends the standard value.
      if (input.listingId) {
        await supabaseAdmin
          .from("listings")
          .update({ item_specifics_override: refit.aspects })
          .eq("id", input.listingId);
      } else {
        await supabaseAdmin
          .from("inventory_items")
          .update({ ebay_aspects: refit.aspects })
          .eq("id", input.itemId);
      }
    }
    if (refit.changed.length === 0 && refit.unresolved.length === 0) return null;
    return { message: sizeEnforcementMessage(refit), changed: refit.changed, unresolved: refit.unresolved };
  } catch (e) {
    console.error("[ebay-size-enforcement] heal failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
