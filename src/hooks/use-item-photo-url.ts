// React hook wrapping the item-photo display resolver (US-2273).
//
// The public/thumbnail path resolves synchronously, so front/back photos render
// on the first frame with no flash, spinner or layout shift. Only the private-
// bucket sensitive case (an iOS-captured tag/certificate with an empty
// photo_url) is asynchronous; its signed URL is cached per storage_path so a
// scrolling gallery signs each object at most once per TTL window.

import { useEffect, useRef, useState } from "react";
import {
  needsSignedDisplayUrl,
  resolveItemPhotoDisplayUrl,
  type PhotoLike,
} from "@/lib/item-photo-url";
import { itemPhotoThumb } from "@/lib/images";

export interface ItemPhotoUrlState {
  url: string;
  loading: boolean;
  /** The mint failed — render a labelled placeholder, not a broken image. */
  failed: boolean;
}

export interface UseItemPhotoUrlOptions {
  width?: number;
  full?: boolean;
}

export function useItemPhotoDisplayUrl(
  photo: PhotoLike,
  { width, full }: UseItemPhotoUrlOptions = {},
): ItemPhotoUrlState {
  // Synchronous fast path for the public case so there is no flash of empty.
  const sync = !needsSignedDisplayUrl(photo);
  const syncUrl = () => (full ? (photo.photo_url ?? "") : itemPhotoThumb(photo, width));
  const [state, setState] = useState<ItemPhotoUrlState>(() =>
    sync
      ? { url: syncUrl(), loading: false, failed: false }
      : { url: "", loading: true, failed: false },
  );

  // Re-run whenever the identity of the underlying object or its display inputs
  // change. storage_path/photo_url/thumbnail_url/photo_type fully determine the
  // resolved URL, so keying on them avoids re-signing on unrelated re-renders.
  const key = `${photo.storage_path ?? ""}|${photo.photo_url ?? ""}|${
    photo.thumbnail_url ?? ""
  }|${photo.photo_type ?? ""}|${width ?? ""}|${full ? "full" : ""}`;
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    if (sync) {
      setState({ url: syncUrl(), loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    resolveItemPhotoDisplayUrl(photo, { width, full })
      .then((url) => {
        if (cancelled || latest.current !== key) return;
        setState({ url, loading: false, failed: url === "" });
      })
      .catch(() => {
        if (cancelled || latest.current !== key) return;
        setState({ url: "", loading: false, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // key encodes every input that changes the resolved URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
