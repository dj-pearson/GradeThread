// US-1542: queue / retry / reattach semantics of the app-level upload store.
// The heavy pipeline stages are mocked (worker-pool compression, media intake,
// EXIF) and the network transport is swapped via the `_transport` test seam,
// so these exercise exactly the store's own logic.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exif", () => ({
  readCaptureTime: vi.fn(async () => null),
}));
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
vi.mock("@/lib/auth-token", () => ({
  forceRefreshAccessToken: vi.fn(async () => null),
}));
vi.mock("@/lib/edge-api", () => ({
  edgeApiUrl: () => "http://edge.test",
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  _transport,
  type StagedUploadResult,
  useAutolisterUploadStore,
} from "./autolister-upload-store";

function makeFile(name: string, contents = `bytes-of-${name}`): File {
  return new File([contents], name, {
    type: "image/jpeg",
    lastModified: 1_700_000_000_000,
  });
}

function okUpload(name: string): StagedUploadResult {
  return {
    storagePath: `staging/${name}`,
    url: `http://cdn.test/${name}`,
    thumbnailStoragePath: null,
    thumbnailUrl: null,
    width: 2000,
    height: 2000,
    bytes: 1234,
  };
}

function resetStore() {
  useAutolisterUploadStore.setState({
    sessionId: null,
    attached: false,
    tasks: [],
    results: [],
  });
  // Fresh session adoption clears the module-level dedup claims.
  useAutolisterUploadStore.getState().attach(`session-${crypto.randomUUID()}`);
  useAutolisterUploadStore.getState().detach();
  window.localStorage.clear();
}

beforeEach(() => {
  resetStore();
  _transport.upload = vi.fn(async (_s, full: Blob) =>
    okUpload((full as File).name ?? "photo"),
  );
});

describe("enqueueFiles (queue)", () => {
  it("uploads a batch, delivers results, and sweeps done tasks", async () => {
    const store = useAutolisterUploadStore.getState();
    await store.enqueueFiles([makeFile("a.jpg"), makeFile("b.jpg")], "s1");

    const state = useAutolisterUploadStore.getState();
    expect(state.tasks).toHaveLength(0); // done rows swept
    expect(state.results).toHaveLength(2);
    expect(state.results.map((r) => r.sourceName).sort()).toEqual(["a.jpg", "b.jpg"]);
    expect(state.sessionId).toBe("s1");
  });

  it("skips duplicate files (same name/size/mtime) within and across batches", async () => {
    const store = useAutolisterUploadStore.getState();
    const file = makeFile("dup.jpg");
    await store.enqueueFiles([file, makeFile("dup.jpg")], "s1");
    await store.enqueueFiles([makeFile("dup.jpg")], "s1");

    expect(useAutolisterUploadStore.getState().results).toHaveLength(1);
    expect(_transport.upload).toHaveBeenCalledTimes(1);
  });

  it("a transient upload failure leaves a retryable error task holding its File", async () => {
    _transport.upload = vi.fn(async () => {
      throw new Error("network down");
    });
    const store = useAutolisterUploadStore.getState();
    await store.enqueueFiles([makeFile("x.jpg")], "s1");

    const [task] = useAutolisterUploadStore.getState().tasks;
    expect(task).toBeDefined();
    expect(task!.status).toBe("error");
    expect(task!.retryable).toBe(true);
    expect(task!.error).toContain("network down");
    expect(task!.file.name).toBe("x.jpg");
    expect(useAutolisterUploadStore.getState().results).toHaveLength(0);
  });
});

describe("retryTasks (retry)", () => {
  it("re-runs a failed pipeline without re-picking, then delivers the photo", async () => {
    let calls = 0;
    _transport.upload = vi.fn(async (_s, full: Blob) => {
      calls++;
      if (calls === 1) throw new Error("blip");
      return okUpload((full as File).name);
    });
    const store = useAutolisterUploadStore.getState();
    await store.enqueueFiles([makeFile("y.jpg")], "s1");
    const failed = useAutolisterUploadStore.getState().tasks[0]!;
    expect(failed.status).toBe("error");

    await store.retryTasks([failed.id]);

    const state = useAutolisterUploadStore.getState();
    expect(state.tasks).toHaveLength(0);
    expect(state.results).toHaveLength(1);
    expect(state.results[0]!.sourceName).toBe("y.jpg");
  });

  it("ignores non-retryable and unknown ids", async () => {
    const store = useAutolisterUploadStore.getState();
    await store.retryTasks(["nope"]);
    expect(_transport.upload).not.toHaveBeenCalled();
  });
});

describe("attach/detach + claim (reattach)", () => {
  it("results delivered while DETACHED merge into the persisted session; the page claims deduped", async () => {
    const store = useAutolisterUploadStore.getState();
    store.attach("s1");
    store.detach(); // user navigated away

    await store.enqueueFiles([makeFile("away.jpg")], "s1");

    // Hard-reload safety: the finished photo landed in the persisted session.
    const raw = window.localStorage.getItem("autolister:state:s1");
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!) as { staged?: Array<{ sourceName?: string }> };
    expect(persisted.staged?.map((p) => p.sourceName)).toEqual(["away.jpg"]);

    // Reattach: results are still claimable in memory.
    store.attach("s1");
    const { results, claimResults } = useAutolisterUploadStore.getState();
    expect(results).toHaveLength(1);
    claimResults(results.map((r) => r.id));
    expect(useAutolisterUploadStore.getState().results).toHaveLength(0);
  });

  it("results delivered while ATTACHED skip the localStorage merge (the page persists)", async () => {
    const store = useAutolisterUploadStore.getState();
    store.attach("s1");
    await store.enqueueFiles([makeFile("here.jpg")], "s1");

    expect(window.localStorage.getItem("autolister:state:s1")).toBeNull();
    expect(useAutolisterUploadStore.getState().results).toHaveLength(1);
  });

  it("attaching with a NEW session while idle resets stale tasks/results", async () => {
    const store = useAutolisterUploadStore.getState();
    store.attach("s1");
    await store.enqueueFiles([makeFile("old.jpg")], "s1");
    expect(useAutolisterUploadStore.getState().results).toHaveLength(1);

    store.attach("s2"); // generated + new session
    const state = useAutolisterUploadStore.getState();
    expect(state.sessionId).toBe("s2");
    expect(state.results).toHaveLength(0);
    expect(state.tasks).toHaveLength(0);
    // …and the old session's dedup claims are gone: the same file re-uploads.
    await state.enqueueFiles([makeFile("old.jpg")], "s2");
    expect(useAutolisterUploadStore.getState().results).toHaveLength(1);
  });
});

describe("lost-upload marker (AC3)", () => {
  it("counts not-done tasks in localStorage and clears when settled", async () => {
    _transport.upload = vi.fn(async () => {
      throw new Error("down");
    });
    const store = useAutolisterUploadStore.getState();
    await store.enqueueFiles([makeFile("l1.jpg"), makeFile("l2.jpg")], "s1");
    expect(window.localStorage.getItem("autolister:lostUploads")).toBe("2");

    // consume: store still HAS the tasks (in-app return) → nothing was lost.
    expect(store.consumeLostUploadCount()).toBe(0);

    // Simulate the post-reload state: store empty FIRST (emptying tasks also
    // clears the live marker — correct while the app keeps running), then the
    // marker as the previous page-load would have left it on disk.
    useAutolisterUploadStore.setState({ tasks: [] });
    window.localStorage.setItem("autolister:lostUploads", "2");
    expect(store.consumeLostUploadCount()).toBe(2);
    expect(window.localStorage.getItem("autolister:lostUploads")).toBeNull();
  });
});
