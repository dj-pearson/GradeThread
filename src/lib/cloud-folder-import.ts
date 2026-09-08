// US-3159: the cloud folder import run, with every effect injected.
//
// Same shape and the same reasons as src/lib/google-photos-import.ts: the rules
// live here where they can be tested without a browser, and the React wrapper
// (src/hooks/use-cloud-folder-import.ts) owns only window, toasts and state.
//
// Three rules worth naming, because each one is a bug someone would otherwise
// find in production:
//
//   1. THE SERVER OWNS THE CURSOR. It returns `nextOffset` and `done`; our own
//      arithmetic is a fallback for a response that did not say, not a parallel
//      source of truth. The Google Photos import learned this one first.
//   2. A CHUNK THAT IMPORTS NOTHING IS NOT A REASON TO STOP. Four dead links in
//      a row still advance the cursor, and a run that halted on an empty chunk
//      would strand every photo after them.
//   3. CANCEL IS CHECKED BETWEEN CHUNKS, NEVER MID-CHUNK. The chunk already
//      landed server-side by the time we could act on it, so stopping early
//      would leave staged photos the seller was told they did not get.

/** One photo the edge has already downloaded, validated and re-uploaded. */
export interface CloudImportedPhoto {
  url: string;
  storagePath: string;
  width: number | null;
  height: number | null;
  bytes: number;
  capturedAtMs: number | null;
}

/** A row in a folder listing. `path` is opaque and goes straight back up. */
export interface CloudEntry {
  id: string;
  name: string;
  kind: "folder" | "file";
  path: string;
  sizeBytes: number | null;
  capturedAtMs: number | null;
}

export interface CloudFolderListing {
  path: string;
  folders: CloudEntry[];
  files: CloudEntry[];
  /** Images the importer cannot read, e.g. HEIC. Counted so it can be said. */
  unreadable: number;
  truncated: boolean;
}

export interface CloudProviderStatus {
  id: string;
  label: string;
  connected: boolean;
  accountLabel: string | null;
}

/** The bit of a Response this module uses. */
export interface CloudFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export interface CloudImportDeps {
  /** Path relative to the edge base, e.g. "/api/flipdesk/cloud/dropbox/list". */
  fetchEdge: (path: string, init?: { method?: string; body?: string }) => Promise<CloudFetchResponse>;
  notify: {
    info: (message: string) => void;
    success: (message: string) => void;
    warning: (message: string) => void;
    error: (message: string) => void;
  };
  /** Called with every chunk as it lands. Awaited, so the next chunk waits. */
  onPhotos: (photos: CloudImportedPhoto[]) => void | Promise<void>;
  /** Progress for the button label. */
  onProgress?: (done: number, total: number) => void;
  /** True once the caller has asked to stop. Checked between chunks only. */
  cancelled: () => boolean;
}

export interface CloudImportResult {
  imported: number;
  failed: number;
  stopped: boolean;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return fallback;
}

/** Which providers this deploy offers and which this seller has connected. */
export async function loadCloudProviders(
  deps: Pick<CloudImportDeps, "fetchEdge">,
): Promise<CloudProviderStatus[]> {
  const res = await deps.fetchEdge("/api/flipdesk/cloud/providers");
  if (!res.ok) return [];
  const body = (await res.json()) as { providers?: CloudProviderStatus[] };
  return Array.isArray(body.providers) ? body.providers : [];
}

/** One folder. An error here is shown, not swallowed — the seller is browsing. */
export async function listCloudFolder(
  deps: Pick<CloudImportDeps, "fetchEdge">,
  providerId: string,
  path: string,
): Promise<CloudFolderListing> {
  const res = await deps.fetchEdge(
    `/api/flipdesk/cloud/${providerId}/list?path=${encodeURIComponent(path)}`,
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(errorMessage(body, "Could not read that folder."));
  }
  const b = (body ?? {}) as Partial<CloudFolderListing>;
  return {
    path: typeof b.path === "string" ? b.path : path,
    folders: Array.isArray(b.folders) ? b.folders : [],
    files: Array.isArray(b.files) ? b.files : [],
    unreadable: typeof b.unreadable === "number" ? b.unreadable : 0,
    truncated: b.truncated === true,
  };
}

interface ImportChunkResponse {
  photos?: CloudImportedPhoto[];
  imported?: number;
  errors?: number;
  total?: number;
  nextOffset?: number;
  done?: boolean;
}

/**
 * Walk the chosen files in chunks until the server says done.
 *
 * Returns rather than throws for the ordinary endings (nothing chosen, the
 * seller cancelled, every file failed) because each of those is something to
 * say in one sentence, not an exception for a caller to interpret.
 */
export async function runCloudFolderImport(
  deps: CloudImportDeps,
  providerId: string,
  paths: readonly string[],
): Promise<CloudImportResult> {
  if (paths.length === 0) {
    deps.notify.warning("Pick at least one photo first.");
    return { imported: 0, failed: 0, stopped: false };
  }

  let offset = 0;
  let imported = 0;
  let failed = 0;
  let total = paths.length;
  const body = JSON.stringify({ paths });

  // A hard ceiling on iterations. The server's own `done` is the real exit; this
  // only stops a malformed response from spinning the loop forever.
  for (let guard = 0; guard < 200; guard++) {
    if (deps.cancelled()) return { imported, failed, stopped: true };

    const res = await deps.fetchEdge(
      `/api/flipdesk/cloud/${providerId}/import?offset=${offset}`,
      { method: "POST", body },
    );
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      deps.notify.error(errorMessage(parsed, "The import stopped part way."));
      return { imported, failed, stopped: false };
    }

    const chunk = (parsed ?? {}) as ImportChunkResponse;
    if (typeof chunk.total === "number" && chunk.total > 0) total = chunk.total;
    const photos = Array.isArray(chunk.photos) ? chunk.photos : [];
    if (photos.length > 0) await deps.onPhotos(photos);
    imported += photos.length;
    failed += typeof chunk.errors === "number" ? chunk.errors : 0;
    deps.onProgress?.(imported + failed, total);

    if (chunk.done === true) break;
    // Rule 1: the server owns the cursor. Only fall back when it did not say.
    const next = typeof chunk.nextOffset === "number" ? chunk.nextOffset : offset + photos.length;
    // A cursor that did not move would loop forever on a chunk of dead links.
    if (next <= offset) break;
    offset = next;
  }

  if (imported === 0 && failed > 0) {
    deps.notify.error("None of those photos could be brought over.");
  } else if (failed > 0) {
    deps.notify.warning(`Brought over ${imported}. ${failed} could not be read.`);
  } else if (imported > 0) {
    deps.notify.success(`Brought over ${imported} ${imported === 1 ? "photo" : "photos"}.`);
  }
  return { imported, failed, stopped: false };
}

// There is deliberately NO path parsing here, and US-3160 is why. A Dropbox
// path looks like "/camera uploads/2026"; a OneDrive path is a Graph item id
// with no separator in it at all. `CloudEntry.path` is opaque by contract, so
// the folder trail is built from the folders the seller actually clicked
// (cloud-folder-dialog.tsx) rather than by splitting a string that only one
// provider happens to shape that way.
