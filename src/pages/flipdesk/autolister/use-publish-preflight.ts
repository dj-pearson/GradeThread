// US-3381 / US-2520. The queue's whole eBay pre-flight: the background wave
// that validates each draft as it finishes generating, the rate pacing both it
// and the publish dialog share, and the dialog's own on-demand validation.
//
// Extracted from autolister-queue.tsx, which sits at its shrink-only ceiling
// exactly. It is also the only cohesive unit in that file: five pieces of state
// and three refs that exist for one question -- is this draft publishable? --
// and nothing else on the page reads any of them.

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { runWithConcurrency } from "@/lib/concurrency";
import { toastWarning } from "@/lib/toast-error";
import type { AutolisterJob } from "@/hooks/use-autolister";
import type { PreflightItem } from "./queue-cells";

// US-1559: minimum spacing between /listings/validate request STARTS. The edge
// rate-limits /ebay/listings/* at 30/min; ~24 starts/min leaves headroom for
// the user's own clicks. Shared (via a ref) by the background pre-flight wave
// and the publish dialog so they can't stack into a 429 storm together.
const VALIDATE_SPACING_MS = 2500;

async function acquireValidateSlot(slotRef: { current: number }): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, slotRef.current);
  slotRef.current = startAt + VALIDATE_SPACING_MS;
  if (startAt > now) {
    await new Promise((resolve) => setTimeout(resolve, startAt - now));
  }
}

export interface PublishPreflight {
  /** The rows the confirm dialog renders. */
  items: PreflightItem[];
  /** A validate round-trip is in flight for at least one row. */
  loading: boolean;
  /** Cached per-item results, driving the per-row queue badge. */
  byItem: Record<string, { blockers: string[]; loaded: boolean }>;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  /** Open the confirm dialog and validate the subset. */
  open: (subset: AutolisterJob[]) => Promise<void>;
}

export function usePublishPreflight(args: {
  jobs: AutolisterJob[];
  ebayConnected: boolean;
  titleOf: (itemId: string) => string;
}): PublishPreflight {
  const { jobs, ebayConnected, titleOf } = args;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [items, setItems] = useState<PreflightItem[]>([]);
  const [loading, setLoading] = useState(false);
  // US-954: background pre-flight cache keyed by inventory_item_id. Each
  // succeeded draft is validated against eBay as it lands, so a per-row
  // ready / will-block badge shows before the seller opens the publish dialog,
  // and the dialog reuses these results instead of re-validating from scratch.
  const [byItem, setByItem] = useState<
    Record<string, { blockers: string[]; loaded: boolean }>
  >({});
  // itemIds already validated or in-flight, so the polling effect never
  // re-fires a validate for the same draft.
  const seenRef = useRef<Set<string>>(new Set());
  // US-1559: global pacing for the pre-flight wave. The edge rate-limits
  // /ebay/listings/* at 30/min; a 44-draft batch validated at concurrency 4
  // with no spacing blew straight through it (a sustained 429 storm, because
  // every 429 re-armed the id and the next poll re-fired it). slotRef spaces
  // request STARTS globally (across overlapping effect runs), and cooldownRef
  // pauses the whole wave after any 429.
  const slotRef = useRef(0);
  const cooldownRef = useRef(0);

  // US-954: background pre-flight. As each draft finishes generating, validate
  // it against eBay (category, required aspects, price range, policies) with
  // bounded concurrency so we respect eBay's rate budget. Skipped until eBay is
  // connected (validate needs a live connection).
  useEffect(() => {
    if (!ebayConnected) return;
    // US-1559: after a 429, pause the whole wave -- hammering the limiter just
    // extends the block. The publish dialog still validates on demand.
    if (Date.now() < cooldownRef.current) return;
    const succeeded = jobs
      .filter((j) => j.status === "success")
      .map((j) => j.inventory_item_id);
    const pending = succeeded.filter((id) => !seenRef.current.has(id));
    if (pending.length === 0) return;
    pending.forEach((id) => seenRef.current.add(id));

    let cancelled = false;
    void runWithConcurrency(pending, 2, async (itemId) => {
      if (cancelled) return;
      await acquireValidateSlot(slotRef);
      if (cancelled || Date.now() < cooldownRef.current) {
        seenRef.current.delete(itemId);
        return;
      }
      try {
        const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
          method: "POST",
          json: { inventory_item_id: itemId },
        });
        if (res.status === 429) {
          // Rate-limited: re-arm this id and cool the wave down for a minute.
          seenRef.current.delete(itemId);
          cooldownRef.current = Date.now() + 60_000;
          return;
        }
        if (!res.ok) {
          // Server/eBay error: never cache a false "ready" -- re-arm instead.
          seenRef.current.delete(itemId);
          return;
        }
        const json = await res.json().catch(() => ({}));
        const blockers = Array.isArray(json.blockers)
          ? (json.blockers as string[])
          : [];
        if (cancelled) return;
        setByItem((prev) => ({ ...prev, [itemId]: { blockers, loaded: true } }));
      } catch {
        // Transient failure: don't cache a false "ready". Re-arm so a later
        // poll re-validates, and let the publish dialog validate it on demand.
        seenRef.current.delete(itemId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [jobs, ebayConnected]);

  // Open the confirmation dialog (US-321) and run pre-flight /listings/validate
  // on each item in parallel. Blockers render per-row and gate the
  // "Publish N clean" button -- items with unresolved blockers are refused.
  async function open(subset: AutolisterJob[]): Promise<void> {
    if (subset.length === 0) return;
    // US-954: seed from the background pre-flight cache so a draft already
    // validated in the queue doesn't re-validate from scratch.
    const initial: PreflightItem[] = subset.map((j) => {
      const cached = byItem[j.inventory_item_id];
      return {
        itemId: j.inventory_item_id,
        listingId: j.listing_id,
        title: titleOf(j.inventory_item_id),
        scheduledFor: null,
        blockers: cached?.loaded ? cached.blockers : [],
        blockersLoaded: cached?.loaded ?? false,
      };
    });
    setItems(initial);
    setDialogOpen(true);
    // Only the items not already cached still need a validate round-trip.
    const needValidation = initial.filter((i) => !i.blockersLoaded);
    setLoading(needValidation.length > 0);

    try {
      // Pull scheduled_publish_at for these drafts so the dialog flags them.
      const itemIds = initial.map((i) => i.itemId);
      const { data: listingRows, error: scheduleErr } = await supabase
        .from("listings")
        .select("inventory_item_id, scheduled_publish_at")
        .in("inventory_item_id", itemIds)
        .eq("listing_status", "draft");
      // US-3381: this read had no error check and the try around it has no
      // catch, so a refusal resolved with `data: null`, every row read as
      // unscheduled, and the dialog invited the seller to publish now over a
      // schedule they had set. It is the one thing in this dialog the seller
      // cannot see is missing.
      if (scheduleErr) {
        toastWarning(scheduleErr, "Couldn't check which drafts are scheduled.", {
          action: "read scheduled_publish_at",
          nextStep:
            "Close this and reopen it before publishing, or a scheduled draft will go live now.",
        });
      }
      const scheduledByItem = new Map<string, string | null>();
      for (const row of (listingRows ?? []) as Array<
        { inventory_item_id: string; scheduled_publish_at: string | null }
      >) {
        scheduledByItem.set(row.inventory_item_id, row.scheduled_publish_at);
      }
      // Apply schedule info to every row (cached + uncached) immediately.
      setItems((prev) =>
        prev.map((p) => ({
          ...p,
          scheduledFor: scheduledByItem.get(p.itemId) ?? null,
        })),
      );

      // Validate only the uncached items, paced under the edge rate limiter
      // (US-1559), warming the shared cache as each completes. A failed or
      // rate-limited validate is a BLOCKER, never a silent "clean" -- and it
      // isn't cached, so reopening the dialog re-validates it.
      await runWithConcurrency(needValidation, 2, async (it) => {
        await acquireValidateSlot(slotRef);
        let blockers: string[];
        let cacheable = true;
        try {
          const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
            method: "POST",
            json: { inventory_item_id: it.itemId },
          });
          if (!res.ok) {
            cacheable = false;
            blockers = [
              res.status === 429
                ? "Rate-limited while validating. Wait a minute and reopen this dialog."
                : "Validation failed. Reopen this dialog to retry.",
            ];
          } else {
            const json = await res.json().catch(() => ({}));
            blockers = Array.isArray(json.blockers)
              ? (json.blockers as string[])
              : [];
          }
        } catch (err) {
          cacheable = false;
          blockers = [
            err instanceof Error ? err.message : "Validation request failed.",
          ];
        }
        setItems((prev) =>
          prev.map((p) =>
            p.itemId === it.itemId ? { ...p, blockers, blockersLoaded: true } : p,
          ),
        );
        if (cacheable) {
          setByItem((prev) => ({ ...prev, [it.itemId]: { blockers, loaded: true } }));
        }
      });
    } finally {
      setLoading(false);
    }
  }

  return { items, loading, byItem, dialogOpen, setDialogOpen, open };
}
