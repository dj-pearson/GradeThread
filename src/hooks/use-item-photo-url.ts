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
  resolveItemPhotoOriginalUrl,
  type PhotoLike,
} from "@/lib/item-photo-url";
import { supabase } from "@/lib/supabase";
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

/**
 * The PRISTINE pre-edit object's URL for the photo editor (US-2208), resolved
 * across the same public/private split as the display URL. Pass null when no
 * original should be used; returns null until it resolves, which the editor
 * already treats as "edit the current image".
 */
export function useItemPhotoOriginalUrl(photo: PhotoLike | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = `${photo?.original_storage_path ?? ""}|${photo?.photo_type ?? ""}|${
    photo?.photo_url ?? ""
  }|${photo?.storage_path ?? ""}`;
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    if (!photo?.original_storage_path) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    resolveItemPhotoOriginalUrl(photo, {
      publicUrl: (path) =>
        supabase.storage.from("item-photos").getPublicUrl(path).data.publicUrl,
    })
      .then((resolved) => {
        if (cancelled || latest.current !== key) return;
        setUrl(resolved || null);
      })
      .catch(() => {
        if (cancelled || latest.current !== key) return;
        setUrl(null);
      });
    return () => {
      cancelled = true;
    };
    // key encodes every input that changes the resolved URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return url;
}
