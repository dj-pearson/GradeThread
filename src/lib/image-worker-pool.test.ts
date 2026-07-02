// Tests for the staging image worker pool (US-539) + the stall watchdogs
// added after the autolister batch-freeze incident: a worker that never
// replies, a reply that can't be delivered, or a script-level crash must fail
// over to the main-thread path instead of hanging the upload lane forever.
//
// The pool holds module-level state (workers, poolBroken), so every test
// imports a FRESH copy via vi.resetModules() + dynamic import.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Main-thread fallback deps — mocked so fallback results are recognizable.
vi.mock("@/lib/image-utils", () => ({
  loadImage: vi.fn(async () => ({ naturalWidth: 2000, naturalHeight: 1500 })),
  compressImage: vi.fn(async () => ({
    blob: new Blob(["main-thread"], { type: "image/webp" }),
    width: 1200,
    height: 900,
    phash: "fallbackhash00000",
  })),
}));

type MessageHandler = ((e: { data: unknown }) => void) | null;

// Configurable fake Worker installed as the global. `behavior` decides what a
// spawned worker does with a posted request.
let behavior: "echo" | "silent" | "decode-fail" | "crash-on-spawn" = "echo";
const spawned: FakeWorker[] = [];

class FakeWorker {
  onmessage: MessageHandler = null;
  onmessageerror: (() => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;

  constructor() {
    spawned.push(this);
    if (behavior === "crash-on-spawn") {
      queueMicrotask(() => this.onerror?.());
    }
  }

  postMessage(req: { id: number }): void {
    if (behavior === "silent") return; // never replies — watchdog territory
    if (behavior === "decode-fail") {
      queueMicrotask(() =>
        this.onmessage?.({
          data: { id: req.id, ok: false, error: "bad file", decodeFailed: true },
        }),
      );
      return;
    }
    queueMicrotask(() =>
      this.onmessage?.({
        data: {
          id: req.id,
          ok: true,
          blob: new Blob(["worker"], { type: "image/webp" }),
          width: 800,
          height: 600,
          phash: "workerhash0000000",
          thumbBlob: null,
          srcWidth: 4000,
          srcHeight: 3000,
        },
      }),
    );
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function freshPool() {
  vi.resetModules();
  return await import("@/lib/image-worker-pool");
}

const file = new File([new Uint8Array([1, 2, 3])], "photo.jpg", {
  type: "image/jpeg",
});

beforeEach(() => {
  behavior = "echo";
  spawned.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({}));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("processStagedImage — worker path", () => {
  it("returns the worker's result when the worker replies", async () => {
    const { processStagedImage } = await freshPool();
    const out = await processStagedImage(file);
    expect(out.phash).toBe("workerhash0000000");
    expect(out.srcWidth).toBe(4000);
    expect(spawned.length).toBe(1);
  });

  it("throws ImageDecodeError (no fallback) when the worker reports decodeFailed", async () => {
    behavior = "decode-fail";
    const { processStagedImage, ImageDecodeError } = await freshPool();
    await expect(processStagedImage(file)).rejects.toBeInstanceOf(ImageDecodeError);
  });

  it("watchdog: a worker that never replies is recycled and the photo falls back to the main thread", async () => {
    behavior = "silent";
    vi.useFakeTimers();
    const { processStagedImage } = await freshPool();
    const pending = processStagedImage(file);
    await vi.advanceTimersByTimeAsync(60_001);
    const out = await pending;
    expect(out.phash).toBe("fallbackhash00000"); // main-thread mock, not a hang
    expect(spawned[0]?.terminated).toBe(true); // the wedged worker was recycled
  });

  it("onmessageerror: an undeliverable reply recycles the worker and falls back", async () => {
    behavior = "silent";
    const { processStagedImage } = await freshPool();
    const pending = processStagedImage(file);
    // Give pump() a tick to post the task, then simulate the clone failure.
    await Promise.resolve();
    spawned[0]!.onmessageerror?.();
    const out = await pending;
    expect(out.phash).toBe("fallbackhash00000");
    expect(spawned[0]?.terminated).toBe(true);
  });

  it("a script-level worker error breaks the pool and every later call uses the fallback", async () => {
    behavior = "crash-on-spawn";
    const { processStagedImage } = await freshPool();
    const first = await processStagedImage(file);
    expect(first.phash).toBe("fallbackhash00000");
    const priorSpawnCount = spawned.length;
    const second = await processStagedImage(file);
    expect(second.phash).toBe("fallbackhash00000");
    expect(spawned.length).toBe(priorSpawnCount); // poolBroken: no respawn attempts
  });
});

describe("processStagedImage — main-thread fallback", () => {
  it("used directly when Worker/OffscreenCanvas are unavailable, with source dims from loadImage", async () => {
    vi.stubGlobal("Worker", undefined);
    const { processStagedImage } = await freshPool();
    const out = await processStagedImage(file);
    expect(out.phash).toBe("fallbackhash00000");
    expect(out.srcWidth).toBe(2000);
    expect(out.srcHeight).toBe(1500);
    expect(out.thumbBlob).not.toBeNull();
  });

  it("skips the thumbnail when thumbWidth is null", async () => {
    vi.stubGlobal("Worker", undefined);
    const { processStagedImage } = await freshPool();
    const out = await processStagedImage(file, { thumbWidth: null });
    expect(out.thumbBlob).toBeNull();
  });

  it("an undecodable file surfaces as ImageDecodeError", async () => {
    vi.stubGlobal("Worker", undefined);
    const { loadImage } = await import("@/lib/image-utils");
    vi.mocked(loadImage).mockRejectedValueOnce(new Error("corrupt"));
    const { processStagedImage, ImageDecodeError } = await freshPool();
    await expect(processStagedImage(file)).rejects.toBeInstanceOf(ImageDecodeError);
  });
});
