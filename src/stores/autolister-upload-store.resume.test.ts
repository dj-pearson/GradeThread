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

import {
  clearAutolisterLocalState,
  fileSig,
  _transport,
  useAutolisterUploadStore,
} from "./autolister-upload-store";
import {
  autolisterSessionKey,
  listBlobs,
  loadSession,
  putBlob,
  saveSession,
  scopeSessionToOwner,
} from "@/lib/autolister-session-idb";

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

describe("clearAutolisterLocalState on sign-out (AL-03)", () => {
  it("leaves user B an empty grid and nothing to resume", async () => {
    // User A: a staged session, a queued file and the scoped session-id key.
    const keyA = autolisterSessionKey("user-a", "user-a");
    window.localStorage.setItem(keyA, "sess-a");
    window.localStorage.setItem("autolister:state:sess-a", JSON.stringify({ staged: [{ id: "p" }] }));
    window.localStorage.setItem("autolister:sessionId", "legacy");
    window.localStorage.setItem("unrelated", "keep");
    await saveSession("sess-a", {
      staged: [{ id: "p", storagePath: "user-a/_staging/sess-a/p.jpg" }],
      groups: [],
      updatedAt: 1,
      ownerId: "user-a",
    });
    await persistBlob("sess-a", "a-original.jpg");
    useAutolisterUploadStore.setState({
      sessionId: "sess-a",
      tasks: [{ id: "t", name: "x.jpg", status: "error", progress: 0, file: makeFile("x.jpg") }],
    });

    await clearAutolisterLocalState();

    // User B signs in on the same browser.
    expect(window.localStorage.getItem(keyA)).toBeNull();
    expect(window.localStorage.getItem("autolister:state:sess-a")).toBeNull();
    expect(window.localStorage.getItem("autolister:sessionId")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
    expect(await loadSession("sess-a")).toBeNull();
    expect(await listBlobs("sess-a")).toHaveLength(0);
    const state = useAutolisterUploadStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.tasks).toHaveLength(0);
    expect(state.results).toHaveLength(0);

    await useAutolisterUploadStore.getState().resumeUploads("sess-a");
    expect(_transport.upload).not.toHaveBeenCalled();
  });

  it("a reset mid-upload never delivers the photo to whoever is signed in next", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    _transport.upload = vi.fn(async (_s, full: Blob) => {
      await gate;
      return {
        storagePath: `staging/${(full as File).name}`,
        url: "http://cdn.test/x",
        thumbnailStoragePath: null,
        thumbnailUrl: null,
        width: 2000,
        height: 2000,
        bytes: 1,
      };
    });
    const run = useAutolisterUploadStore.getState().enqueueFiles([makeFile("mid.jpg")], "s1");
    await flush();
    useAutolisterUploadStore.getState().reset();
    release();
    await run;
    expect(useAutolisterUploadStore.getState().results).toHaveLength(0);
    expect(useAutolisterUploadStore.getState().tasks).toHaveLength(0);
  });
});

describe("scopeSessionToOwner (AL-03)", () => {
  const photo = (id: string, owner: string) => ({
    id,
    storagePath: `${owner}/_staging/s/${id}.jpg`,
  });

  it("drops a row stamped for another owner", () => {
    const out = scopeSessionToOwner(
      { staged: [photo("a", "owner-a")], groups: [], updatedAt: 0, ownerId: "owner-a" },
      "owner-b",
    );
    expect(out).toEqual({ session: null, foreign: true, trusted: false });
  });

  it("filters a legacy row to this owner's photos and marks it untrusted", () => {
    const out = scopeSessionToOwner(
      {
        staged: [photo("mine", "owner-b"), photo("theirs", "owner-a")],
        groups: [
          { id: "g1", photoIds: ["theirs", "mine"], coverId: "theirs" },
          { id: "g2", photoIds: ["theirs"], coverId: "theirs" },
        ],
        updatedAt: 0,
      },
      "owner-b",
    );
    expect(out.trusted).toBe(false);
    expect(out.session?.staged.map((p) => (p as { id: string }).id)).toEqual(["mine"]);
    expect(out.session?.groups).toEqual([{ id: "g1", photoIds: ["mine"], coverId: "mine" }]);
  });

  it("keeps a row stamped for this owner and trusts it", () => {
    const out = scopeSessionToOwner(
      { staged: [photo("a", "owner-b")], groups: [], updatedAt: 0, ownerId: "owner-b" },
      "owner-b",
    );
    expect(out.trusted).toBe(true);
    expect(out.session?.staged).toHaveLength(1);
  });
});
