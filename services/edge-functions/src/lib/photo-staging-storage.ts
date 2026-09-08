// US-3157: the two-method adapter that connects remote-photo-import.ts to the
// real bucket.
//
// It exists so the import core can stay free of the service-role client and of
// `Deno.env`, which is what lets its tests run with nothing behind them. This
// file is the only part that knows there is a Supabase bucket at all, and it is
// deliberately too small to hold a decision.

import { supabaseAdmin } from "./supabase.ts";
import type { PhotoStaging } from "./remote-photo-import.ts";

/**
 * Staging in `item-photos`, the one PUBLIC bucket (US-276). That is correct for
 * seller listing imagery and only for that: a staged import is on its way to a
 * listing photo, never to a grading label, a receipt or anything with a face on
 * a document. A future private-bucket source needs its own adapter, not a flag
 * on this one.
 */
export function itemPhotoStaging(): PhotoStaging {
  return {
    async upload(path, bytes, contentType) {
      const { error } = await supabaseAdmin.storage
        .from("item-photos")
        .upload(path, bytes, { upsert: false, contentType });
      return { error: error ? { message: error.message } : null };
    },
    publicUrl(path) {
      // item-photo-url-ok: a staging object in the public bucket, not an
      // item_photos row — there is no private variant to resolve.
      return supabaseAdmin.storage.from("item-photos").getPublicUrl(path).data.publicUrl;
    },
  };
}
