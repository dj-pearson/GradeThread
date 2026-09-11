// US-3389: the AutoLister's four "drop the objects nobody points at any more"
// cleanups, in one place, with their result actually read.
//
// WHAT WAS WRONG. All four were `void supabase.storage.from("item-photos")
// .remove(orphans)`. A storage remove RESOLVES with { data, error } like every
// other supabase builder, so a refusal -- an expired token, an RLS change, a
// 400 on a malformed path -- produced no rejection, no log and no sign on
// screen. `void` then discarded even the possibility of noticing.
//
// WHY A STRANDED STAGED OBJECT IS NOT SELF-HEALING. Staged photos live at
// `{ownerId}/_staging/{session}/...` in `item-photos`, the one PUBLIC bucket,
// and the ONLY pointer to them is the page's `staged` array in React state.
// Once that state drops a path the object is unreferenced, and nothing on the
// server will ever find it again: there is no staging-sweep cron (check the
// CRON list in services/edge-functions/src/lib/cron-runs.ts), and the erasure
// sweep discovers item-photos objects through `item_photos.storage_path` rows,
// not by listing the folder (services/edge-functions/src/lib/
// account-storage-purge.ts). A garment photo with a face, a receipt or a
// name-bearing care label in it therefore stays readable by URL forever.
//
// WHY THIS DOES NOT THROW, when persistDelete (src/lib/photo-mutations.ts) and
// the uploader's Remove (US-3381) both do. Those two delete a DB row second, so
// refusing to delete the row keeps the pointer and the seller can retry. There
// is no row here and nothing to retry: by the time the cleanup runs the staged
// state has already been rewritten, the replacement photo is already uploaded,
// and the operation the seller asked for (delete from batch / enhance / undo /
// save edit) has genuinely succeeded. Throwing would turn a completed edit into
// a failure -- and the re-stage cleanup runs once per photo inside applyBgToAll
// and enhanceAll, so it would abort those partway and leave a worse mixed
// state, which is exactly what US-3381 hit with the SKU throw. So: report, and
// carry on. The defect being fixed is the SILENCE, not the continuing.
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { captureException } from "@/lib/sentry";

/** The one storage verb this needs. Narrow so a test can hand over a fake. */
export interface StagedObjectStore {
  remove(paths: string[]): PromiseLike<{ error?: unknown }>;
}

export interface DiscardOptions {
  /**
   * Tell the seller when the delete is refused. TRUE for the one path where
   * they pressed Delete themselves and are reading a "Deleted N photos"
   * success toast: leaving that unqualified is the success-toast-over-a-
   * stranded-blob shape this story is about. FALSE for the three
   * supersede-after-a-successful-write paths, where the seller never knew the
   * replaced object existed and a warning would be noise they cannot act on.
   */
  notify?: boolean;
  /** Injected by tests. Defaults to the real public bucket. */
  store?: StagedObjectStore;
}

/**
 * Delete staged storage objects that nothing points at any more.
 *
 * Resolves true when they are gone (or there were none), false when the bucket
 * refused and they are now stranded. Never rejects: see the header.
 */
export async function discardStagedObjects(
  paths: string[],
  userAction: string,
  options: DiscardOptions = {},
): Promise<boolean> {
  if (paths.length === 0) return true;
  const store = options.store ?? supabase.storage.from("item-photos");
  const { error } = await store.remove(paths);
  if (!error) return true;

  captureException(error, {
    tags: { surface: "flipdesk.autolister" },
    extra: { user_action: userAction, stranded_objects: paths },
  });
  if (options.notify) {
    toast.warning(
      `${paths.length} photo file${paths.length === 1 ? "" : "s"} could not ` +
        "be deleted from storage. They are out of your batch either way, and " +
        "we have logged it.",
    );
  }
  return false;
}
