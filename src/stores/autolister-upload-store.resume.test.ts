// US-1905: upload resume from IndexedDB after a reload. Separate file so
// fake-indexeddb only affects these tests — the base store test stays on jsdom
// (no IndexedDB), preserving the localStorage-fallback lost-upload behavior.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exif", () => ({ readCaptureTime: vi.fn(async () => null) }));
vi.mock("@/lib/media-intake", () => ({
  MediaIntakeError: class MediaIntakeError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
  normalizeToImageFile: vi.fn(async (file: File) => file),
}));
vi.mock("@/lib/image-worker-pool", () => ({
  ImageDecodeError: class ImageDecodeError extends Error {},
  processStagedImage: vi.fn(async (file: File) => ({
    blob: file,
    width: 2000,
    height: 2000,
    srcWidth: 2000,
    srcHeight: 2000,
    phash: "0000000000000000",
    thumbBlob: null,
  })),
}));
vi.mock("@/lib/edge-fetch", () => ({
  edgeAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test" })),
}));
vi.mock("@/lib/auth-token", () => ({ forceRefreshAccessToken: vi.fn(async () => null) }));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "http://edge.test" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { fileSig, _transport, useAutolisterUploadStore } from "./autolister-upload-store";
import { listBlobs, putBlob } from "@/lib/autolister-session-idb";

function makeFile(name: string): File {
  return new File([`bytes-of-${name}`], name, {
    type: "image/jpeg",
    lastModified: 1_700_000_000_000,
  });
}

function delDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("autolister");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

const flush = () => new Promise((r) => setTimeout(r, 40));

async function persistBlob(sessionId: string, name: string) {
  const file = makeFile(name);
  await putBlob({
    taskId: `task-${name}`,
    sessionId,
    sig: fileSig(file),
    name,
    type: file.type,
    blob: file,
    createdAt: Date.now(),
  });
}

beforeEach(async () => {
  await delDb();
  useAutolisterUploadStore.setState({ sessionId: null, attached: false, tasks: [], results: [] });
  useAutolisterUploadStore.getState().attach(`session-${crypto.randomUUID()}`);
  useAutolisterUploadStore.getState().detach();
  window.localStorage.clear();
  _transport.upload = vi.fn(async (_s, full: Blob) => ({
    storagePath: `staging/${(full as File).name}`,
    url: `http://cdn.test/${(full as File).name}`,
    thumbnailStoragePath: null,
    thumbnailUrl: null,
    width: 2000,
    height: 2000,
    bytes: 1234,
  }));
});

describe("resumeUploads (US-1905)", () => {
  // NOTE: fake-indexeddb + jsdom does not round-trip Blob *bytes* (a store's
  // retrieved blob has no readable body), so these cover the resume PLUMBING
  // (blob → task → upload → result → delete). Byte fidelity is a browser
  // IndexedDB guarantee exercised only in a real browser.
  it("re-runs a blob persisted before a reload and clears it on success", async () => {
    await persistBlob("s1", "a.jpg");
    expect(await listBlobs("s1")).toHaveLength(1);

    await useAutolisterUploadStore.getState().resumeUploads("s1");

    const state = useAutolisterUploadStore.getState();
    expect(state.results).toHaveLength(1);
    expect(state.tasks).toHaveLength(0); // done rows swept
    await flush();
    expect(await listBlobs("s1")).toHaveLength(0); // deleted on success
  });

  it("skips a blob whose file is already staged", async () => {
    const file = makeFile("dup.jpg");
    await putBlob({
      taskId: "task-dup",
      sessionId: "s1",
      sig: fileSig(file),
      name: "dup.jpg",
      type: file.type,
      blob: file,
      createdAt: Date.now(),
    });
    useAutolisterUploadStore.getState().syncStagedIdentities(new Set([fileSig(file)]), new Set());

    await useAutolisterUploadStore.getState().resumeUploads("s1");

    expect(useAutolisterUploadStore.getState().results).toHaveLength(0);
    expect(_transport.upload).not.toHaveBeenCalled();
    expect(await listBlobs("s1")).toHaveLength(1); // untouched, still resumable
  });

  it("keeps the persisted blob when a queued upload fails retryably", async () => {
    _transport.upload = vi.fn(async () => {
      throw new Error("network down");
    });
    await useAutolisterUploadStore.getState().enqueueFiles([makeFile("x.jpg")], "s1");
    await flush();
    const [task] = useAutolisterUploadStore.getState().tasks;
    expect(task?.status).toBe("error");
    expect(task?.retryable).not.toBe(false);
    expect(await listBlobs("s1")).toHaveLength(1); // kept for a post-reload resume
  });
});
