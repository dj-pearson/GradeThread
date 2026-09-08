// US-3140: the Google Photos import sequence, proved BEFORE the AutoLister is
// cut over to it. Every effect is injected, so these run with no browser, no
// network, no timers and no toast renderer.
//
// The four rules from the module header each have a case here, because each of
// them cost a production bug: the picker window closing is not cancellation,
// there is no short pick deadline, the download is chunked and paced, and the
// server owns the cursor.
import { describe, expect, it, vi } from "vitest";
import {
  type GooglePhotosFetchResponse,
  type GooglePhotosImportedPhoto,
  runGooglePhotosImport,
} from "./google-photos-import";

function res(
  status: number,
  body: unknown = {},
): GooglePhotosFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function photo(n: number): GooglePhotosImportedPhoto {
  return {
    url: `https://example.test/${n}.jpg`,
    storagePath: `owner/_staging/${n}.jpg`,
    width: 1200,
    height: 1600,
    bytes: 1000 + n,
    capturedAtMs: 1_700_000_000_000 + n,
  };
}

/** A notifier that records every message, so a test can assert on wording. */
function notifier() {
  const calls: { level: string; message: string }[] = [];
  return {
    calls,
    info: (message: string) => calls.push({ level: "info", message }),
    success: (message: string) => calls.push({ level: "success", message }),
    warning: (message: string) => calls.push({ level: "warning", message }),
    error: (message: string) => calls.push({ level: "error", message }),
    said: (fragment: string) =>
      calls.some((c) => c.message.includes(fragment)),
  };
}

/**
 * A scripted edge. `routes` maps a path fragment to a queue of responses; the
 * last one repeats, so a poll can be scripted as "not ready, then ready".
 */
function edge(routes: Record<string, GooglePhotosFetchResponse[]>) {
  const seen: string[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, [...v]]));
  const fetchEdge = async (path: string) => {
    seen.push(path);
    for (const [fragment, queue] of queues) {
      if (path.includes(fragment)) {
        return queue.length > 1 ? queue.shift()! : queue[0]!;
      }
    }
    throw new Error(`unscripted path: ${path}`);
  };
  return { fetchEdge, seen };
}

const START_OK = res(200, { session_id: "s1", picker_uri: "https://picker.test" });

/** Base deps: a popup that opens, a clock that never advances, no real sleep. */
function baseDeps(overrides: Partial<Parameters<typeof runGooglePhotosImport>[0]> = {}) {
  const notify = notifier();
  const closed = { count: 0 };
  const photos: GooglePhotosImportedPhoto[] = [];
  const progress: ({ done: number; total: number } | null)[] = [];
  return {
    notify,
    closed,
    photos,
    progress,
    deps: {
      openWindow: () => ({ close: () => void closed.count++ }),
      onPhotos: (batch: GooglePhotosImportedPhoto[]) => {
        photos.push(...batch);
      },
      onProgress: (p: { done: number; total: number } | null) => {
        progress.push(p);
      },
      notify,
      now: () => 0,
      sleep: async () => {},
      ...overrides,
    },
  };
}

describe("runGooglePhotosImport — the happy path", () => {
  it("starts, picks, downloads and reports what it imported", async () => {
    const { fetchEdge, seen } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1), photo(2)], total: 2, done: true }),
      ],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });

    expect(out).toEqual({ status: "imported", imported: 2, errors: 0, total: 2 });
    expect(h.photos).toHaveLength(2);
    expect(h.notify.said("Imported 2 photos")).toBe(true);
    expect(seen.some((p) => p.includes("oauth/start"))).toBe(true);
  });

  it("closes the picker window itself once the server says ready", async () => {
    // Rule 1: WE close the window, after the server reports ready. The window
    // closing is never the signal we act on.
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [res(200, { photos: [photo(1)], total: 1, done: true })],
    });
    const h = baseDeps();
    await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(h.closed.count).toBe(1);
  });

  it("says nothing was imported rather than claiming success", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [res(200, { photos: [], total: 0, done: true })],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("empty");
    expect(h.notify.said("No photos were imported")).toBe(true);
  });

  it("uses the consent url on a first-time import", async () => {
    const opened: string[] = [];
    const { fetchEdge } = edge({
      "oauth/start": [res(200, { session_id: "s1", consent_url: "https://consent.test" })],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [res(200, { photos: [photo(1)], total: 1, done: true })],
    });
    const h = baseDeps({
      openWindow: (url: string) => {
        opened.push(url);
        return { close: () => {} };
      },
    });
    await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(opened).toEqual(["https://consent.test"]);
  });

  it("prefers the picker uri over the consent url when both come back", async () => {
    const opened: string[] = [];
    const { fetchEdge } = edge({
      "oauth/start": [
        res(200, {
          session_id: "s1",
          consent_url: "https://consent.test",
          picker_uri: "https://picker.test",
        }),
      ],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [res(200, { photos: [photo(1)], total: 1, done: true })],
    });
    const h = baseDeps({
      openWindow: (url: string) => {
        opened.push(url);
        return { close: () => {} };
      },
    });
    await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(opened).toEqual(["https://picker.test"]);
  });
});

describe("runGooglePhotosImport — polling for the pick", () => {
  it("keeps polling while the session is not ready", async () => {
    // Rule 2: the pick takes as long as it takes.
    const { fetchEdge, seen } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [
        res(200, { ready: false }),
        res(200, { ready: false }),
        res(200, { ready: true }),
      ],
      "photos/import": [res(200, { photos: [photo(1)], total: 1, done: true })],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("imported");
    expect(seen.filter((p) => p.includes("photos/poll"))).toHaveLength(3);
  });

  it("keeps polling through a transient network error", async () => {
    let calls = 0;
    const fetchEdge = async (path: string) => {
      if (path.includes("oauth/start")) return START_OK;
      if (path.includes("photos/poll")) {
        calls++;
        if (calls === 1) throw new Error("network blip");
        return res(200, { ready: true });
      }
      return res(200, { photos: [photo(1)], total: 1, done: true });
    };
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("imported");
    expect(calls).toBe(2);
  });

  it("stops when the server says the session is gone", async () => {
    for (const status of [404, 410]) {
      const { fetchEdge } = edge({
        "oauth/start": [START_OK],
        "photos/poll": [res(status)],
      });
      const h = baseDeps();
      const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
      expect(out.status).toBe("expired");
      expect(h.notify.said("session expired")).toBe(true);
    }
  });

  it("gives up only at the outer safety net, not on a schedule", async () => {
    let clock = 0;
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: false })],
    });
    const h = baseDeps({
      now: () => clock,
      // Every poll advances the clock by ten minutes.
      sleep: async () => {
        clock += 10 * 60_000;
      },
    });
    const out = await runGooglePhotosImport({
      ...h.deps,
      fetchEdge,
      pickMaxMs: 45 * 60_000,
    });
    expect(out.status).toBe("timed-out");
    // Five sleeps to pass 45 minutes — the pick is not cut off early.
    expect(clock).toBeGreaterThanOrEqual(45 * 60_000);
  });
});

describe("runGooglePhotosImport — the chunked download", () => {
  it("follows the server's cursor across chunks and paces between them", async () => {
    // Rules 3 and 4 together.
    const paused: number[] = [];
    const { fetchEdge, seen } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1), photo(2)], total: 5, nextOffset: 2 }),
        res(200, { photos: [photo(3), photo(4)], total: 5, nextOffset: 4 }),
        res(200, { photos: [photo(5)], total: 5, nextOffset: 5 }),
      ],
    });
    const h = baseDeps({
      sleep: async (ms: number) => {
        paused.push(ms);
      },
    });
    const out = await runGooglePhotosImport({
      ...h.deps,
      fetchEdge,
      chunkPauseMs: 750,
    });

    expect(out).toEqual({ status: "imported", imported: 5, errors: 0, total: 5 });
    expect(h.photos).toHaveLength(5);
    // The offsets came from nextOffset, not from our own arithmetic.
    const imports = seen.filter((p) => p.includes("photos/import"));
    expect(imports[0]).toContain("offset=0");
    expect(imports[1]).toContain("offset=2");
    expect(imports[2]).toContain("offset=4");
    // Paced between chunks, not after the last one.
    expect(paused).toEqual([750, 750]);
  });

  it("hands each chunk over as it lands, not all at the end", async () => {
    const seenAt: number[] = [];
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1)], total: 2, nextOffset: 1 }),
        res(200, { photos: [photo(2)], total: 2, nextOffset: 2 }),
      ],
    });
    const h = baseDeps({
      onPhotos: (batch: GooglePhotosImportedPhoto[]) => {
        seenAt.push(batch.length);
      },
    });
    await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(seenAt).toEqual([1, 1]);
  });

  it("waits for an async onPhotos before pulling the next chunk", async () => {
    // The Composer's consumer re-uploads each photo, which is slow. A chunk
    // must not start downloading while the previous one is still being handled.
    const order: string[] = [];
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1)], total: 2, nextOffset: 1 }),
        res(200, { photos: [photo(2)], total: 2, nextOffset: 2 }),
      ],
    });
    const h = baseDeps({
      onPhotos: async () => {
        order.push("handle:start");
        await Promise.resolve();
        order.push("handle:end");
      },
      sleep: async () => {
        order.push("pause");
      },
    });
    await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(order).toEqual([
      "handle:start",
      "handle:end",
      "pause",
      "handle:start",
      "handle:end",
    ]);
  });

  it("stops on the server's done flag even when the cursor would go on", async () => {
    const { fetchEdge, seen } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1)], total: 9, nextOffset: 7, done: true }),
      ],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.imported).toBe(1);
    expect(seen.filter((p) => p.includes("photos/import"))).toHaveLength(1);
  });

  it("stops rather than looping when the cursor does not advance", async () => {
    const { fetchEdge, seen } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [res(200, { photos: [photo(1)], total: 5, nextOffset: 0 })],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("imported");
    expect(seen.filter((p) => p.includes("photos/import"))).toHaveLength(1);
  });

  it("falls back to its own arithmetic only when the server gives no cursor", async () => {
    const { fetchEdge, seen } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1), photo(2)], total: 3 }),
        res(200, { photos: [photo(3)], total: 3 }),
      ],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.imported).toBe(3);
    expect(seen.filter((p) => p.includes("photos/import"))[1]).toContain("offset=2");
  });

  it("counts the photos the edge could not read and says so", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1)], total: 3, errors: 2, done: true }),
      ],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.errors).toBe(2);
    expect(h.notify.said("2 couldn't be read")).toBe(true);
  });

  it("warns when the pick hit the server's cap", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [res(200, { photos: [photo(1)], total: 200, done: true })],
    });
    const h = baseDeps();
    await runGooglePhotosImport({ ...h.deps, fetchEdge, maxImport: 200 });
    expect(h.notify.said("capped at 200 photos")).toBe(true);
  });

  it("reports progress as it goes and clears it at the end", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1)], total: 2, nextOffset: 1 }),
        res(200, { photos: [photo(2)], total: 2, nextOffset: 2 }),
      ],
    });
    const h = baseDeps();
    await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(h.progress).toEqual([
      { done: 0, total: 0 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
      null,
    ]);
  });
});

describe("runGooglePhotosImport — cancellation", () => {
  it("stops during the pick and says so", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: false })],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({
      ...h.deps,
      fetchEdge,
      signal: controller.signal,
    });
    expect(out.status).toBe("cancelled");
    expect(h.notify.said("import cancelled")).toBe(true);
  });

  it("stops at the next chunk boundary and keeps what already arrived", async () => {
    const controller = new AbortController();
    const { fetchEdge, seen } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1)], total: 5, nextOffset: 1 }),
        res(200, { photos: [photo(2)], total: 5, nextOffset: 2 }),
      ],
    });
    const h = baseDeps({
      onPhotos: (batch: GooglePhotosImportedPhoto[]) => {
        h.photos.push(...batch);
        controller.abort();
      },
    });
    const out = await runGooglePhotosImport({
      ...h.deps,
      fetchEdge,
      signal: controller.signal,
      stoppedMessage: "Stopped — the photos already brought over are below.",
    });

    expect(out).toEqual({ status: "cancelled", imported: 1, errors: 0, total: 5 });
    expect(h.photos).toHaveLength(1);
    expect(seen.filter((p) => p.includes("photos/import"))).toHaveLength(1);
    expect(h.notify.said("already brought over are below")).toBe(true);
    // Progress is cleared on the way out, never left spinning.
    expect(h.progress[h.progress.length - 1]).toBeNull();
  });
});

describe("runGooglePhotosImport — the failures a seller can hit", () => {
  it("says so when the server has no Google credentials configured", async () => {
    const { fetchEdge } = edge({ "oauth/start": [res(503)] });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("not-configured");
    expect(h.notify.said("isn't configured yet")).toBe(true);
  });

  it("surfaces the server's own message when the start fails", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [res(500, { error: "Google said no." })],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("failed");
    expect(h.notify.said("Google said no.")).toBe(true);
  });

  it("fails cleanly when the start returns no session", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [res(200, { picker_uri: "https://picker.test" })],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("failed");
  });

  it("tells the seller to allow popups, and never polls", async () => {
    const { fetchEdge, seen } = edge({ "oauth/start": [START_OK] });
    const h = baseDeps({ openWindow: () => null });
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("popup-blocked");
    expect(h.notify.said("allow popups")).toBe(true);
    expect(seen.some((p) => p.includes("photos/poll"))).toBe(false);
  });

  it("stops the download on a server error and keeps the earlier chunks", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [START_OK],
      "photos/poll": [res(200, { ready: true })],
      "photos/import": [
        res(200, { photos: [photo(1)], total: 4, nextOffset: 1 }),
        res(500, { error: "chunk blew up" }),
      ],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out).toEqual({ status: "failed", imported: 1, errors: 0, total: 4 });
    expect(h.notify.said("chunk blew up")).toBe(true);
    expect(h.progress[h.progress.length - 1]).toBeNull();
  });

  it("never throws — a thrown fetch comes back as a status", async () => {
    const fetchEdge = vi.fn(async () => {
      throw new Error("offline");
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("failed");
    expect(h.notify.said("Could not start Google Photos")).toBe(true);
  });

  it("survives a response whose body is not JSON", async () => {
    const { fetchEdge } = edge({
      "oauth/start": [
        {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("not json");
          },
        },
      ],
    });
    const h = baseDeps();
    const out = await runGooglePhotosImport({ ...h.deps, fetchEdge });
    expect(out.status).toBe("failed");
  });
});
