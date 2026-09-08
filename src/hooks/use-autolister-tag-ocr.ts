// US-3139: the AutoLister's automatic group namer.
//
// A group is minted as "Item 3" the moment photos land in it. This hook reads
// the group's tag photo in the browser (tesseract.js — no model, no cost, no
// quota), asks the edge to resolve a brand out of that text, and renames the
// group to "Levi's 32x34".
//
// Three rules it never breaks:
//   1. It only ever writes over a name NOBODY chose — isDefaultGroupName. A
//      name the seller typed, or one an earlier pass wrote, is left alone.
//   2. It attempts each (group, tag photo) pair once. Re-tagging a photo or
//      dropping a different tag into the group makes it eligible again;
//      re-rendering does not.
//   3. It proposes nothing rather than something wrong. No brand and no usable
//      filename leaves "Item 3" in place.

import { useCallback, useEffect, useRef, useState } from "react";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  buildGroupName,
  extractSizeFromOcr,
  isDefaultGroupName,
  planOcrPass,
  uniqueGroupName,
} from "@/lib/autolister-tag-ocr";
import { recognizeImageText } from "@/lib/tesseract-ocr";

/** The shape this hook needs off an AutoLister group. */
export interface TagOcrGroup {
  id: string;
  name: string;
  coverId: string;
  photoIds: string[];
  roles?: Record<string, string>;
}

/** The shape this hook needs off a staged photo. */
export interface TagOcrPhoto {
  id: string;
  url: string;
  sourceName?: string;
}

export interface TagOcrRename {
  id: string;
  name: string;
}

export interface UseAutolisterTagOcrOptions {
  groups: readonly TagOcrGroup[];
  photoById: ReadonlyMap<string, TagOcrPhoto>;
  /** False while the seller has no entitlement, or the surface is not visible. */
  enabled: boolean;
  /** Applied as one state update per batch. Must not itself toast per group. */
  onRenamed: (renames: TagOcrRename[]) => void;
}

// Wait for the group list to settle before spending a wasm load on it: photos
// arrive one upload at a time, and a group's tag photo is often the third file
// in. Long enough to cover a burst, short enough that a rename lands while the
// seller is still looking at the group.
const SETTLE_MS = 1500;

// Groups per round trip. Small enough that the first names appear early in a
// 40-item session, large enough that the brand lookup is not one call each.
const BATCH_SIZE = 4;

interface OcrResult {
  groupId: string;
  text: string;
  size: string | null;
  sourceName?: string;
}

export function useAutolisterTagOcr({
  groups,
  photoById,
  enabled,
  onRenamed,
}: UseAutolisterTagOcrOptions): { busy: boolean } {
  const [busy, setBusy] = useState(false);

  // Latest-value refs: the pass is a long async loop and must not run against
  // the groups as they were when it started.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const photosRef = useRef(photoById);
  photosRef.current = photoById;
  const onRenamedRef = useRef(onRenamed);
  onRenamedRef.current = onRenamed;

  // `${groupId}:${photoId}` for every pair already tried, hit or miss.
  const attemptedRef = useRef<Set<string>>(new Set());
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  /** Resolve brands for one batch of OCR reads and hand back the renames. */
  const nameBatch = useCallback(async (batch: OcrResult[]): Promise<void> => {
    const withText = batch.filter((r) => r.text.trim() !== "");
    let brands = new Map<string, string | null>();
    if (withText.length > 0) {
      try {
        const res = await edgeFetch("/api/flipdesk/autolister/tag-brand", {
          method: "POST",
          json: { groups: withText.map((r) => ({ id: r.groupId, text: r.text })) },
        });
        if (res.ok) {
          const json = (await res.json()) as {
            results?: { id?: string; brand?: string | null }[];
          };
          brands = new Map(
            (json.results ?? [])
              .filter((r): r is { id: string; brand: string | null } =>
                typeof r.id === "string"
              )
              .map((r) => [r.id, r.brand ?? null]),
          );
        }
      } catch {
        // A failed lookup is not a failed pass — the filename fallback below
        // still names what it can, and the pair stays marked attempted so we
        // do not re-OCR the same photo on the next render.
      }
    }

    // Uniqueness is judged against the names that exist RIGHT NOW plus the ones
    // this batch is about to assign.
    const taken = new Set(
      groupsRef.current
        .filter((g) => !isDefaultGroupName(g.name))
        .map((g) => g.name),
    );
    const renames: TagOcrRename[] = [];
    for (const result of batch) {
      // Re-check: the seller may have typed a name while OCR was running.
      const current = groupsRef.current.find((g) => g.id === result.groupId);
      if (!current || !isDefaultGroupName(current.name)) continue;
      const proposed = buildGroupName({
        brand: brands.get(result.groupId) ?? null,
        size: result.size,
        sourceName: result.sourceName,
      });
      if (!proposed) continue;
      const unique = uniqueGroupName(proposed, taken);
      taken.add(unique);
      renames.push({ id: result.groupId, name: unique });
    }
    if (renames.length > 0) onRenamedRef.current(renames);
  }, []);

  const runPass = useCallback(async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      let batch: OcrResult[] = [];
      // Snapshot the queue up front: renaming a group inside the loop changes
      // groupsRef, and iterating that live would re-walk the list.
      const queue = planOcrPass(groupsRef.current, attemptedRef.current);

      for (const job of queue) {
        if (controller.signal.aborted) return;
        attemptedRef.current.add(job.key);

        const group = groupsRef.current.find((g) => g.id === job.groupId);
        const cover = group ? photosRef.current.get(group.coverId) : undefined;
        let text = "";
        if (job.photoId) {
          const photo = photosRef.current.get(job.photoId);
          if (photo) {
            try {
              text = await recognizeImageText(photo.url, controller.signal);
            } catch {
              // Unreadable photo, expired URL, wasm refused to load. The group
              // keeps "Item 3" and the filename fallback still gets a turn.
              text = "";
            }
          }
        }
        if (controller.signal.aborted) return;

        batch.push({
          groupId: job.groupId,
          text,
          size: text ? extractSizeFromOcr(text) : null,
          sourceName: cover?.sourceName,
        });
        if (batch.length >= BATCH_SIZE) {
          await nameBatch(batch);
          batch = [];
          if (controller.signal.aborted) return;
        }
      }
      if (batch.length > 0 && !controller.signal.aborted) await nameBatch(batch);
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setBusy(false);
    }
  }, [nameBatch]);

  useEffect(() => {
    if (!enabled) return;
    // Anything to do at all? Cheap check, so the timer is not armed on every
    // render of a fully named session.
    const hasWork = groups.some((g) => isDefaultGroupName(g.name));
    if (!hasWork) return;
    const timer = setTimeout(() => void runPass(), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [groups, enabled, runPass]);

  // Cancel an in-flight pass when the surface goes away.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { busy };
}
