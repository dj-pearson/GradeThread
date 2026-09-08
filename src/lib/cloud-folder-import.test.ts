import { describe, expect, it, vi } from "vitest";
import {
  type CloudFetchResponse,
  type CloudImportDeps,
  listCloudFolder,
  loadCloudProviders,
  runCloudFolderImport,
} from "@/lib/cloud-folder-import";

// US-3159. Every case here is a rule the module's header names, because each
// one is a production bug in the version that did not have it.

function jsonRes(body: unknown, ok = true, status = 200): CloudFetchResponse {
  return { ok, status, json: () => Promise.resolve(body) };
}

function deps(
  responses: CloudFetchResponse[],
  over: Partial<CloudImportDeps> = {},
): { d: CloudImportDeps; calls: string[]; photos: unknown[][] } {
  const calls: string[] = [];
  const photos: unknown[][] = [];
  const queue = [...responses];
  const d: CloudImportDeps = {
    fetchEdge: (path) => {
      calls.push(path);
      return Promise.resolve(queue.shift() ?? jsonRes({ done: true }));
    },
    notify: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
    onPhotos: (p) => {
      photos.push(p);
    },
    cancelled: () => false,
    ...over,
  };
  return { d, calls, photos };
}

function photo(n: number) {
  return {
    url: `https://cdn.test/${n}.jpg`,
    storagePath: `o/_staging/dropbox/${n}.jpg`,
    width: 4,
    height: 4,
    bytes: 10,
    capturedAtMs: null,
  };
}

describe("cloud folder import (US-3159)", () => {
  it("walks chunks until the server says done, taking the cursor from the server", async () => {
    const { d, calls, photos } = deps([
      jsonRes({ photos: [photo(1), photo(2)], total: 5, nextOffset: 2, done: false, errors: 0 }),
      jsonRes({ photos: [photo(3), photo(4)], total: 5, nextOffset: 4, done: false, errors: 0 }),
      jsonRes({ photos: [photo(5)], total: 5, nextOffset: 5, done: true, errors: 0 }),
    ]);
    const result = await runCloudFolderImport(d, "dropbox", ["a", "b", "c", "d", "e"]);
    expect(result).toEqual({ imported: 5, failed: 0, stopped: false });
    expect(photos.flat()).toHaveLength(5);
    expect(calls.map((c) => c.split("offset=")[1])).toEqual(["0", "2", "4"]);
  });

  it("a chunk that imports nothing still advances rather than stranding the rest", async () => {
    // Four dead links in a row is not a reason to abandon photo five.
    const { d } = deps([
      jsonRes({ photos: [], total: 5, nextOffset: 4, done: false, errors: 4 }),
      jsonRes({ photos: [photo(5)], total: 5, nextOffset: 5, done: true, errors: 0 }),
    ]);
    const result = await runCloudFolderImport(d, "dropbox", ["a", "b", "c", "d", "e"]);
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(4);
  });

  it("a cursor that does not move ends the run instead of looping forever", async () => {
    const { d, calls } = deps([
      jsonRes({ photos: [], total: 3, nextOffset: 0, done: false, errors: 3 }),
    ]);
    const result = await runCloudFolderImport(d, "dropbox", ["a", "b", "c"]);
    expect(calls).toHaveLength(1);
    expect(result.imported).toBe(0);
  });

  it("cancel is honoured between chunks, and the photos already staged are kept", async () => {
    let seen = 0;
    const { d, photos } = deps(
      [
        jsonRes({ photos: [photo(1)], total: 4, nextOffset: 1, done: false, errors: 0 }),
        jsonRes({ photos: [photo(2)], total: 4, nextOffset: 2, done: false, errors: 0 }),
      ],
      { cancelled: () => seen >= 1 },
    );
    const original = d.onPhotos;
    d.onPhotos = (p) => {
      seen += 1;
      return original(p);
    };
    const result = await runCloudFolderImport(d, "dropbox", ["a", "b", "c", "d"]);
    expect(result.stopped).toBe(true);
    expect(result.imported).toBe(1);
    expect(photos.flat()).toHaveLength(1);
  });

  it("nothing chosen is a sentence, not an exception", async () => {
    const { d } = deps([]);
    const result = await runCloudFolderImport(d, "dropbox", []);
    expect(result).toEqual({ imported: 0, failed: 0, stopped: false });
    expect(d.notify.warning).toHaveBeenCalled();
  });

  it("a refusal from the edge is shown in the edge's own words", async () => {
    const { d } = deps([jsonRes({ error: "Your Dropbox sign-in expired. Connect it again." }, false, 409)]);
    const result = await runCloudFolderImport(d, "dropbox", ["a"]);
    expect(result.imported).toBe(0);
    expect(d.notify.error).toHaveBeenCalledWith("Your Dropbox sign-in expired. Connect it again.");
  });

  it("a listing keeps the unreadable count so an empty-looking folder can be explained", async () => {
    const { d } = deps([
      jsonRes({ path: "/camera uploads", folders: [], files: [], unreadable: 12, truncated: false }),
    ]);
    const listing = await listCloudFolder(d, "dropbox", "/camera uploads");
    expect(listing.unreadable).toBe(12);
    expect(listing.files).toEqual([]);
  });

  it("a listing failure carries the edge's reason rather than a generic one", async () => {
    const { d } = deps([jsonRes({ error: "Dropbox is not connected." }, false, 409)]);
    await expect(listCloudFolder(d, "dropbox", "")).rejects.toThrow("Dropbox is not connected.");
  });

  it("no providers configured reads as an empty list, never an error", async () => {
    const { d } = deps([jsonRes({}, false, 503)]);
    expect(await loadCloudProviders(d)).toEqual([]);
  });

  it("a provider path is passed through untouched, never parsed", async () => {
    // US-3160: a Dropbox path is slash-delimited and a OneDrive path is a Graph
    // item id with no separator. Anything here that split a path would render a
    // raw id at the second provider, so nothing does.
    const { d, calls } = deps([jsonRes({ folders: [], files: [], unreadable: 0 })]);
    await listCloudFolder(d, "onedrive", "01ABCDEF!123");
    expect(calls[0]).toContain(`path=${encodeURIComponent("01ABCDEF!123")}`);
  });

});
