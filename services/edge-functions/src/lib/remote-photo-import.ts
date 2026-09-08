// US-3157: the one place a photo comes into FlipDesk from somewhere else.
//
// Google Photos was the first remote photo source (US-1539) and for a while it
// was the only one, so its download → validate → strip → upload loop lived
// inside flipdesk-google-photos.ts. Google Drive, Dropbox and OneDrive are the
// same loop with a different way of naming files, and three more copies of a
// sequence whose steps are SECURITY steps is how one of them quietly loses the
// EXIF strip. This module owns the sequence; a provider owns only the list.
//
// WHAT A PROVIDER STILL OWNS, and why it is not in here:
//
//   1. **The host allowlist.** Only the provider knows which hosts its download
//      URLs may legitimately point at, and the check matters because the
//      caller's bearer token rides on the download request — a poisoned URL
//      pointing at an attacker host would hand them that token (US-579). So
//      `allowHost` is required, not optional, and a descriptor whose URL fails
//      it is refused before any fetch.
//   2. **Paging.** `planImportChunk` is here because every provider needs the
//      same cursor, but calling it is the route's job: this module imports a
//      CHUNK, never a whole pick. A 200-file import is far more work than one
//      HTTP request should carry, and a module that quietly looped the whole
//      list would put the timeout back.
//   3. **Anything that reads the environment.** This file reads no `Deno.env`
//      and imports no Supabase client, which is what lets its tests run with no
//      stack behind them. Storage arrives as `PhotoStaging`; the adapter for
//      the real `item-photos` bucket lives in photo-staging-storage.ts.
//
// ONE FILE FAILING IS NOT THE RUN FAILING. A dead link, a HEIC that is really a
// PDF, a file over the size cap: each is recorded against its own descriptor id
// and the remaining files still import. A seller who picked forty photos and
// has one bad one wants thirty-nine photos and a sentence, not an error page.

import { validateImageUpload } from "./upload-validation.ts";
import { stripImageMetadata } from "./image-metadata.ts";

/** Bound on a single import across ALL of its chunks. */
export const MAX_IMPORT = 200;
/** The pace one POST imports; MAX_CHUNK stops a client asking for everything. */
export const DEFAULT_CHUNK = 25;
export const MAX_CHUNK = 40;
/** Downloads in flight at once. Four is polite to the provider and to us. */
export const DOWNLOAD_CONCURRENCY = 4;
/** Per-file ceiling. Anything larger is a camera raw or a mistake. */
export const IMPORT_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Chunk cursor for an import request. Pure and exported so the boundaries — the
 * last chunk, an over-long limit, a client that asks past the end — are pinned
 * by tests instead of only by a live 200-photo import.
 */
export function planImportChunk(
  total: number,
  rawOffset: unknown,
  rawLimit: unknown,
): { offset: number; limit: number; end: number; nextOffset: number; done: boolean } {
  const o = Number(rawOffset ?? 0);
  const offset = Number.isFinite(o) && o > 0 ? Math.min(Math.floor(o), MAX_IMPORT) : 0;
  const l = Number(rawLimit ?? DEFAULT_CHUNK);
  const limit = Number.isFinite(l) && l > 0
    ? Math.min(Math.floor(l), MAX_CHUNK)
    : DEFAULT_CHUNK;
  const capped = Math.min(total, MAX_IMPORT);
  const start = Math.min(offset, capped);
  const end = Math.min(start + limit, capped);
  const nextOffset = end;
  // `end <= start` means the client asked past the end — treat that as done so
  // a bad cursor can't spin the loop forever.
  const done = end <= start || end >= capped;
  return { offset: start, limit, end, nextOffset, done };
}

/** One file a provider wants imported. Everything provider-shaped ends here. */
export interface RemotePhotoFile {
  /** The provider's own id. Only used to name a failure, never to build a path. */
  id: string;
  /** Absolute download URL. Checked against `allowHost` before it is fetched. */
  url: string;
  /** Sent with the download — usually the caller's bearer token. */
  headers?: Record<string, string>;
  /** When the photo was taken, if the provider knows. */
  capturedAtMs?: number | null;
}

/** A photo that made it all the way through. Same shape the clients already read. */
export interface ImportedPhoto {
  url: string;
  storagePath: string;
  width: number | null;
  height: number | null;
  bytes: number;
  capturedAtMs: number | null;
}

/** Why one file did not import. The id is the provider's, so it can be shown. */
export interface RemotePhotoFailure {
  id: string;
  reason: string;
}

export interface RemotePhotoImportResult {
  photos: ImportedPhoto[];
  failures: RemotePhotoFailure[];
}

/**
 * The slice of storage this needs. Narrow on purpose: a test passes an object
 * with two methods rather than standing up a bucket.
 */
export interface PhotoStaging {
  upload(
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ error: { message: string } | null }>;
  publicUrl(path: string): string;
}

export interface RemotePhotoImportOptions {
  /** Whose folder the file lands in. The storage RLS path rule reads this. */
  ownerId: string;
  /**
   * The `_staging/<key>/` segment, e.g. "gphotos" or "gdrive". Provider-named
   * so a half-finished import is identifiable in the bucket; it is NOT read
   * back as a provider name by anything in here.
   */
  stagingKey: string;
  storage: PhotoStaging;
  /** Which download hosts this provider considers its own. Required (see above). */
  allowHost: (host: string) => boolean;
  fetchFn: typeof fetch;
  maxBytes?: number;
  concurrency?: number;
}

/** `true` only for a hostname the provider claims. Never throws. */
function hostAllowed(url: string, allowHost: (host: string) => boolean): boolean {
  try {
    return allowHost(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Download, validate, strip and stage one chunk of files.
 *
 * The caller has already sliced the chunk with `planImportChunk`; passing a
 * whole 200-file pick here would work and would also be the timeout this design
 * exists to avoid.
 */
export async function importRemotePhotos(
  files: readonly RemotePhotoFile[],
  opts: RemotePhotoImportOptions,
): Promise<RemotePhotoImportResult> {
  const maxBytes = opts.maxBytes ?? IMPORT_MAX_BYTES;
  const concurrency = Math.max(1, opts.concurrency ?? DOWNLOAD_CONCURRENCY);
  const photos: ImportedPhoto[] = [];
  const failures: RemotePhotoFailure[] = [];

  async function importOne(file: RemotePhotoFile): Promise<void> {
    try {
      if (!file.url) throw new Error("no download url");
      if (!hostAllowed(file.url, opts.allowHost)) {
        // Deliberately does not echo the host: the message reaches a seller.
        throw new Error("refused a download host this source does not own");
      }

      const res = await opts.fetchFn(file.url, { headers: file.headers ?? {} });
      if (!res.ok) throw new Error(`download ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());

      const valid = validateImageUpload(bytes, {
        allow: ["jpeg", "png", "webp"],
        maxBytes,
      });
      if (!valid.ok) throw new Error(valid.reason);

      const clean = stripImageMetadata(bytes, valid.format);
      const id = crypto.randomUUID();
      const path = `${opts.ownerId}/_staging/${opts.stagingKey}/${id}.${valid.ext}`;
      const { error } = await opts.storage.upload(path, clean.bytes, valid.contentType);
      if (error) throw new Error(error.message);

      photos.push({
        url: opts.storage.publicUrl(path),
        storagePath: path,
        width: valid.width,
        height: valid.height,
        bytes: clean.bytes.length,
        capturedAtMs: file.capturedAtMs ?? null,
      });
    } catch (err) {
      failures.push({
        id: file.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (let i = 0; i < files.length; i += concurrency) {
    await Promise.all(files.slice(i, i + concurrency).map(importOne));
  }

  return { photos, failures };
}
