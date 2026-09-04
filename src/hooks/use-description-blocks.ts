// US-2960: the composer's description blocks, loaded from and saved to the edge.
//
// The renderer lives on the edge service only (decision 6), so this hook holds
// the block ARRAY locally and asks functions.gradethread.com for every string it
// shows. Four routes, all under /api/flipdesk/description/ (US-2958):
//
//   GET  /:listingId/blocks   load, converting a legacy description on the way
//   POST /preview             render an unsaved array
//   POST /:listingId/save     persist blocks + the string they render to
//   POST /:listingId/regenerate  rewrite one AI block
//
// CONVERT-ON-OPEN IS NOT A WRITE. GET returns the parsed blocks AND the string
// they render to; that string is used as the first preview verbatim rather than
// being re-requested, which is what makes "the preview equals the stored
// description byte for byte before any edit" true rather than nearly true.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  createPreviewScheduler,
  PREVIEW_DEBOUNCE_MS,
} from "@/lib/description-preview";
import type {
  DescriptionBlock,
  DescriptionBlockKey,
  DescriptionSegment,
} from "@/types/database";

export interface UseDescriptionBlocksResult {
  blocks: DescriptionBlock[];
  setBlocks: (next: DescriptionBlock[]) => void;
  /** The exact string eBay will receive, or "" while it has never been rendered. */
  preview: string;
  /**
   * The same render in pieces (US-3114). Glued in order it equals `preview`, so
   * the clickable preview panel and the published string are one render, not
   * two. Empty until the edge has rendered once.
   */
  segments: DescriptionSegment[];
  previewPending: boolean;
  loading: boolean;
  /** True when the blocks shown came from parsing a legacy description. */
  converted: boolean;
  /**
   * False while the rows on screen are a local placeholder rather than this
   * listing's real blocks. `save` refuses in that state — see the note there.
   */
  ready: boolean;
  /**
   * Re-render the CURRENT array against fresh item data (US-3114).
   *
   * The preview effect below only fires when the blocks or the unit change, and
   * a derived block's content lives on the item row instead — so editing a
   * measurement from the preview changes what the description says without
   * changing a single block. This is how that edit reaches the panel.
   */
  refreshPreview: () => void;
  /** Persist the current array. Returns the rendered description, or null. */
  save: (listingId: string) => Promise<string | null>;
  /** Rewrite one AI block server-side. Returns true when it landed. */
  regenerate: (key: DescriptionBlockKey) => Promise<boolean>;
  regenerating: DescriptionBlockKey | null;
}

interface BlocksResponse {
  blocks?: DescriptionBlock[];
  preview?: string;
  segments?: DescriptionSegment[];
  converted?: boolean;
  description?: string;
}

export function useDescriptionBlocks(opts: {
  listingId: string | null;
  unit: "in" | "cm";
  /** Blocks to start from when the listing has no row yet. */
  seed: DescriptionBlock[];
  enabled?: boolean;
}): UseDescriptionBlocksResult {
  const { listingId, unit, seed } = opts;
  const enabled = opts.enabled !== false;

  const [blocks, setBlocksState] = useState<DescriptionBlock[]>(seed);
  const [preview, setPreview] = useState("");
  const [segments, setSegments] = useState<DescriptionSegment[]>([]);
  const [previewPending, setPreviewPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [converted, setConverted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [regenerating, setRegenerating] = useState<DescriptionBlockKey | null>(null);

  // The array the save path reads. State would be a render behind on the call
  // saveDraft makes immediately after a toggle.
  const blocksRef = useRef<DescriptionBlock[]>(seed);
  const setBlocks = useCallback((next: DescriptionBlock[]) => {
    blocksRef.current = next;
    setBlocksState(next);
  }, []);

  const unitRef = useRef(unit);
  unitRef.current = unit;

  // The array (and unit) the preview panel's current string was rendered from.
  // Identity, not deep equality: a new array object is a real edit, and a server
  // response that hands back both the blocks and their render sets this so the
  // effect below does not immediately ask for the same bytes again.
  const previewedBlocks = useRef<DescriptionBlock[] | null>(seed);
  const previewedUnit = useRef<string>(unit);

  /** Adopt a server response: blocks, the string they rendered to, and the guard. */
  const adopt = useCallback(
    (
      next: DescriptionBlock[],
      description: string,
      nextSegments?: DescriptionSegment[],
    ) => {
      blocksRef.current = next;
      previewedBlocks.current = next;
      setBlocksState(next);
      setPreview(description);
      // An older edge build answers without segments. The panel falls back to
      // the raw string then rather than showing a preview with no regions, so a
      // deploy lag degrades the clicking, never the description.
      setSegments(Array.isArray(nextSegments) ? nextSegments : []);
    },
    [],
  );

  // ── Load ────────────────────────────────────────────────────────
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !listingId) return;
    if (loadedFor.current === listingId) return;
    loadedFor.current = listingId;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await edgeFetch(
          `/api/flipdesk/description/${listingId}/blocks?unit=${unitRef.current}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as BlocksResponse;
        if (cancelled || !Array.isArray(body.blocks)) return;
        // The preview is adopted VERBATIM, not re-rendered. See the header note.
        adopt(body.blocks, body.preview ?? "", body.segments);
        setConverted(body.converted === true);
        setHydrated(true);
      } catch {
        // Silent: the card falls back to the rows it already has, and Save is
        // still the deliberate retry. A toast per failed load would fire on
        // every offline tab switch.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, listingId, adopt]);

  // ── Preview ─────────────────────────────────────────────────────
  const scheduler = useMemo(
    () =>
      createPreviewScheduler<
        { listingId: string; blocks: DescriptionBlock[]; unit: string },
        { preview: string; segments: DescriptionSegment[] }
      >({
        delayMs: PREVIEW_DEBOUNCE_MS,
        fetcher: async (payload) => {
          const res = await edgeFetch("/api/flipdesk/description/preview", {
            method: "POST",
            json: {
              listing_id: payload.listingId,
              blocks: payload.blocks,
              unit: payload.unit,
            },
          });
          if (!res.ok) throw new Error(`preview ${res.status}`);
          const body = (await res.json()) as BlocksResponse;
          return {
            preview: body.preview ?? "",
            segments: Array.isArray(body.segments) ? body.segments : [],
          };
        },
        onResult: (result) => {
          setPreview(result.preview);
          setSegments(result.segments);
        },
        onPending: setPreviewPending,
      }),
    [],
  );
  useEffect(() => () => scheduler.cancel(), [scheduler]);

  // Re-render whenever the array or the unit changes — EXCEPT when the string
  // for that exact array is already in hand. Every server response carries both
  // the blocks and the bytes they rendered to, so re-requesting them would spend
  // a round trip to be told the same thing, and on the first load it would
  // replace the byte-for-byte legacy conversion with a second render of it.
  // Identity, not deep equality: a new array object is a real edit.
  useEffect(() => {
    if (!enabled || !listingId) return;
    if (previewedBlocks.current === blocks && previewedUnit.current === unit) {
      return;
    }
    previewedBlocks.current = blocks;
    previewedUnit.current = unit;
    scheduler.request({ listingId, blocks, unit });
  }, [enabled, listingId, blocks, unit, scheduler]);

  const refreshPreview = useCallback(() => {
    if (!enabled || !listingId) return;
    // Clearing the guard matters: it holds the array the panel's current string
    // was rendered from, and leaving it set would make the effect above skip the
    // very next legitimate block edit as "already previewed".
    previewedBlocks.current = null;
    scheduler.request({
      listingId,
      blocks: blocksRef.current,
      unit: unitRef.current,
    });
  }, [enabled, listingId, scheduler]);

  // ── Save ────────────────────────────────────────────────────────
  //
  // A listing with no row yet has nothing to load, so the local seed IS its
  // blocks. A listing that HAS a row has real blocks on the server, and until
  // the GET has handed them over the rows on screen are a placeholder — saving
  // then would render a description out of empty prose and overwrite a real one.
  // That is not hypothetical: migration 00678 is not applied everywhere yet, and
  // where it is missing the GET 404s.
  const ready = listingId ? hydrated : true;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const save = useCallback(async (id: string): Promise<string | null> => {
    if (!readyRef.current) return null;
    try {
      const res = await edgeFetch(`/api/flipdesk/description/${id}/save`, {
        method: "POST",
        json: { blocks: blocksRef.current, unit: unitRef.current },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as BlocksResponse;
      const description = body.description ?? "";
      // The array the server echoed back IS what it just rendered, so `adopt`
      // records it and the preview effect does not ask for it again.
      adopt(
        Array.isArray(body.blocks) ? body.blocks : blocksRef.current,
        description,
        body.segments,
      );
      setConverted(false);
      return description;
    } catch {
      return null;
    }
  }, [adopt]);

  // ── Regenerate one block ────────────────────────────────────────
  const regenerate = useCallback(
    async (key: DescriptionBlockKey): Promise<boolean> => {
      if (!listingId) return false;
      setRegenerating(key);
      try {
        const res = await edgeFetch(
          `/api/flipdesk/description/${listingId}/regenerate`,
          { method: "POST", json: { block: key, unit: unitRef.current } },
        );
        if (!res.ok) return false;
        const body = (await res.json()) as BlocksResponse;
        adopt(
          Array.isArray(body.blocks) ? body.blocks : blocksRef.current,
          body.description ?? "",
          body.segments,
        );
        return true;
      } catch {
        return false;
      } finally {
        setRegenerating(null);
      }
    },
    [listingId, adopt],
  );

  return {
    blocks,
    setBlocks,
    preview,
    segments,
    previewPending,
    loading,
    converted,
    ready,
    refreshPreview,
    save,
    regenerate,
    regenerating,
  };
}
