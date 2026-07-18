// The AutoLister upload store — session/task/result bookkeeping.
//
// Tested through the store's own API rather than through React: it is a plain
// Zustand store, so getState() drives it directly and no renderHook (or
// @testing-library, which this repo does not carry) is needed.
//
// The behaviours picked here are the ones where a bug loses a seller's work:
// dropping a fresh session's tasks, resurrecting claimed results, or
// mis-reporting how many uploads a reload destroyed.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const { useAutolisterUploadStore, fileSig, MIN_RESOLUTION, BORDERLINE_RESOLUTION } = await import(
  "@/stores/autolister-upload-store"
);

const store = () => useAutolisterUploadStore.getState();

function task(id: string, status: string) {
  return { id, status, name: `${id}.jpg`, progress: 0 } as never;
}

beforeEach(() => {
  useAutolisterUploadStore.setState({ sessionId: null, attached: false, tasks: [], results: [] });
  window.localStorage.clear();
});

describe("fileSig", () => {
  it("identifies a file by name, size and mtime", () => {
    const f = { name: "IMG_1.jpg", size: 1234, lastModified: 99 } as File;
    expect(fileSig(f)).toBe("IMG_1.jpg|1234|99");
  });

  it("distinguishes a re-picked copy with a different name", () => {
    const a = { name: "IMG_1.jpg", size: 10, lastModified: 1 } as File;
    const b = { name: "IMG_1 copy.jpg", size: 10, lastModified: 1 } as File;
    expect(fileSig(a)).not.toBe(fileSig(b));
  });
});

describe("resolution thresholds", () => {
  it("keeps the borderline bar above the hard minimum", () => {
    // Inverting these would either reject usable photos or silently accept
    // ones eBay will not zoom.
    expect(BORDERLINE_RESOLUTION).toBeGreaterThan(MIN_RESOLUTION);
  });
});

describe("attach", () => {
  it("clears leftovers when a DIFFERENT session attaches with nothing in flight", () => {
    // The previous session was generated or cleared away; carrying its rows
    // into a new one shows a seller photos that belong to a finished batch.
    useAutolisterUploadStore.setState({
      sessionId: "old",
      tasks: [task("t1", "done")],
      results: [{ id: "r1" } as never],
    });
    store().attach("new");
    expect(store().sessionId).toBe("new");
    expect(store().tasks).toEqual([]);
    expect(store().results).toEqual([]);
    expect(store().attached).toBe(true);
  });

  it("KEEPS in-flight work when a different session attaches", () => {
    // Uploads still running belong to the seller. Wiping them here would
    // discard bytes already sent.
    useAutolisterUploadStore.setState({ sessionId: "old", tasks: [task("t1", "uploading")], results: [] });
    store().attach("new");
    expect(store().tasks).toHaveLength(1);
    expect(store().sessionId).toBe("old");
  });

  it("adopts the session id when there is none yet", () => {
    store().attach("s1");
    expect(store().sessionId).toBe("s1");
  });

  it("detach leaves tasks alone and only flips the flag", () => {
    useAutolisterUploadStore.setState({ tasks: [task("t1", "uploading")], attached: true });
    store().detach();
    expect(store().attached).toBe(false);
    expect(store().tasks).toHaveLength(1);
  });
});

describe("task list", () => {
  it("dismissTask removes only the named task", () => {
    useAutolisterUploadStore.setState({ tasks: [task("a", "failed"), task("b", "failed")] });
    store().dismissTask("a");
    expect(store().tasks.map((t) => t.id)).toEqual(["b"]);
  });

  it("dismissing an unknown id is a no-op, not a wipe", () => {
    useAutolisterUploadStore.setState({ tasks: [task("a", "failed")] });
    store().dismissTask("nope");
    expect(store().tasks).toHaveLength(1);
  });

  it("clearTasks empties tasks but not results", () => {
    // Results are staged photos the page may not have claimed yet; clearing
    // the task rows must not throw those away.
    useAutolisterUploadStore.setState({ tasks: [task("a", "done")], results: [{ id: "r1" } as never] });
    store().clearTasks();
    expect(store().tasks).toEqual([]);
    expect(store().results).toHaveLength(1);
  });
});

describe("claimResults", () => {
  it("removes exactly the claimed ids", () => {
    useAutolisterUploadStore.setState({
      results: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] as never,
    });
    store().claimResults(["r1", "r3"]);
    expect(store().results.map((r) => r.id)).toEqual(["r2"]);
  });

  it("claiming twice does not resurrect anything", () => {
    // The page claims on render; a double render must not re-add photos it
    // already moved into staged state.
    useAutolisterUploadStore.setState({ results: [{ id: "r1" }] as never });
    store().claimResults(["r1"]);
    store().claimResults(["r1"]);
    expect(store().results).toEqual([]);
  });

  it("ignores ids it does not hold", () => {
    useAutolisterUploadStore.setState({ results: [{ id: "r1" }] as never });
    store().claimResults(["other"]);
    expect(store().results).toHaveLength(1);
  });
});

describe("consumeLostUploadCount", () => {
  it("reports and clears the marker left by a hard unload", () => {
    window.localStorage.setItem("autolister:lostUploads", "3");
    expect(store().consumeLostUploadCount()).toBe(3);
    // Consumed: a second read must not re-warn on the next mount.
    expect(store().consumeLostUploadCount()).toBe(0);
  });

  it("returns 0 when tasks survived — nothing was lost", () => {
    // An in-app return keeps the store alive, so the marker is stale and
    // warning about it would be a lie.
    window.localStorage.setItem("autolister:lostUploads", "3");
    useAutolisterUploadStore.setState({ tasks: [task("a", "uploading")] });
    expect(store().consumeLostUploadCount()).toBe(0);
  });

  it("treats junk or non-positive markers as nothing lost", () => {
    for (const raw of ["", "abc", "0", "-2"]) {
      window.localStorage.setItem("autolister:lostUploads", raw);
      expect(store().consumeLostUploadCount(), `raw=${JSON.stringify(raw)}`).toBe(0);
    }
  });

  it("returns 0 when no marker exists", () => {
    expect(store().consumeLostUploadCount()).toBe(0);
  });
});

describe("syncStagedIdentities", () => {
  it("accepts the staged sets without throwing and is idempotent", () => {
    // The page hands over what is already staged so re-dropping the same
    // folder is skipped before any compression work happens.
    expect(() => {
      store().syncStagedIdentities(new Set(["a|1|1"]), new Set(["hash1"]));
      store().syncStagedIdentities(new Set(["a|1|1"]), new Set(["hash1"]));
    }).not.toThrow();
  });

  it("handles empty sets (nothing staged yet)", () => {
    expect(() => store().syncStagedIdentities(new Set(), new Set())).not.toThrow();
  });
});

describe("enqueueFiles", () => {
  it("is a no-op for an empty batch", async () => {
    await store().enqueueFiles([], "s1");
    expect(store().tasks).toEqual([]);
  });
});
