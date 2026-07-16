// US-1910: AutoLister at scale v2 — the composed end-to-end pass.
//
// Every leg of the scale-v2 epic (US-1903..US-1909, US-1911) has its own unit
// test, but each proves ONE stage against a hand-built fixture. This file walks
// the founder's actual 2026-07-09 session shape — 600 photos, no EXIF, ~45
// items — through the WHOLE pipeline in one go, asserting the invariant that
// ties the epic together: **nothing is lost**. Every photo that goes in comes
// out assigned to exactly one group, every group gets AI-verified, and a
// mid-session reload resumes rather than dropping queued work.
//
// The AI calls are simulated (a perfect proposer over ground truth) — this is
// the WIRING and the seam/window/coverage math at scale, not model accuracy.
// The generation funnel's half of AC1 (vision input always includes the
// available defect + tag shots) is edge-side; it is covered by the sibling
// services/edge-functions/src/tests/autolister-scale-e2e_test.ts.
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
  autoGroupPhotos,
  type GroupablePhoto,
  MAX_AUTO_GROUP_PHOTOS,
} from "./autolister-grouping";
import {
  type ClientProposedGroup,
  mergeProposalWindows,
  planProposeWindows,
  PROPOSE_WINDOW,
} from "./autolister-propose-windows";
import {
  dedupeSuggestions,
  MAX_VERIFY_SAMPLE_PHOTOS,
  planVerifyWindows,
  sampledSizeForVerify,
} from "./autolister-verify-windows";
import { computeTriage, type TriageGroup } from "./autolister-triage";
import { loadSession, putBlob, saveSession } from "./autolister-session-idb";
import { fileSig, _transport, useAutolisterUploadStore } from "@/stores/autolister-upload-store";

// ── The session under test ────────────────────────────────────────────────

const TOTAL_PHOTOS = 600;
const ITEM_COUNT = 45;

/** mulberry32 — deterministic, so a failure is always reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

/** A 64-bit dHash as the 16 hex chars the pipeline expects. */
function phashOf(hi: number, lo: number): string {
  return hex8(hi) + hex8(lo);
}

/** Flip `bits` random bits of a base hash — a near-identical shot of one item. */
function nearby(hi: number, lo: number, bits: number, rand: () => number): string {
  let h = hi;
  let l = lo;
  for (let i = 0; i < bits; i++) {
    const b = Math.floor(rand() * 64);
    if (b < 32) h ^= 1 << b;
    else l ^= 1 << (b - 32);
  }
  return phashOf(h, l);
}

/** Per-item photo counts summing to exactly TOTAL_PHOTOS (8..19 — the real
 *  spread of a shoot; over half the items exceed MAX_AUTO_GROUP_PHOTOS). */
function itemSizes(): number[] {
  const sizes: number[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) sizes.push(8 + ((i * 7) % 11));
  let sum = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; sum !== TOTAL_PHOTOS; i = (i + 1) % ITEM_COUNT) {
    if (sum < TOTAL_PHOTOS) {
      sizes[i]!++;
      sum++;
    } else if (sizes[i]! > 1) {
      sizes[i]!--;
      sum--;
    }
  }
  return sizes;
}

/** Role cycle of a real shoot: a front, a back, a tag, details, a defect. */
const ROLE_CYCLE = ["front", "back", "tag", "detail", "detail_2", "defect"];

interface Session {
  photos: GroupablePhoto[];
  /** photoId → the item it truly belongs to (ground truth). */
  itemOf: Map<string, string>;
  /** itemId → its photo ids, in shooting order. */
  items: Map<string, string[]>;
  roles: Record<string, string>;
}

/**
 * A camera dump with NO EXIF at all (the iOS/Android library gave no date, and
 * the founder's session had none): every photo is timeless, and the only
 * ordering signal is one CONTIGUOUS filename run IMG_0001..IMG_0600 spanning
 * the whole folder — deliberately the shape US-1550 guards against, since a
 * single run is exactly what used to collapse into one boundary-free
 * mega-group.
 */
function buildSession(): Session {
  const rand = rng(1910);
  const sizes = itemSizes();
  const photos: GroupablePhoto[] = [];
  const itemOf = new Map<string, string>();
  const items = new Map<string, string[]>();
  const roles: Record<string, string> = {};

  let seq = 1;
  for (let i = 0; i < ITEM_COUNT; i++) {
    const itemId = `item-${String(i).padStart(2, "0")}`;
    // A fresh random 64-bit base per item: two random hashes sit ~32 bits
    // apart, far outside the merge threshold, so items never bleed together.
    const hi = Math.floor(rand() * 0x100000000);
    const lo = Math.floor(rand() * 0x100000000);
    const ids: string[] = [];
    for (let j = 0; j < sizes[i]!; j++) {
      const id = `photo-${String(seq).padStart(3, "0")}`;
      photos.push({
        id,
        capturedAt: null, // ← no EXIF anywhere in the session
        phash: nearby(hi, lo, 2, rand), // same item ⇒ near-identical shot
        sourceName: `IMG_${String(seq).padStart(4, "0")}.JPG`,
      });
      itemOf.set(id, itemId);
      roles[id] = ROLE_CYCLE[j % ROLE_CYCLE.length]!;
      ids.push(id);
      seq++;
    }
    items.set(itemId, ids);
  }
  return { photos, itemOf, items, roles };
}

/** A perfect /propose-groups: contiguous runs of one item within the window. */
function fakeProposeGroups(windowIds: string[], itemOf: Map<string, string>) {
  const out: ClientProposedGroup[] = [];
  for (const id of windowIds) {
    const item = itemOf.get(id)!;
    const last = out[out.length - 1];
    if (last && itemOf.get(last.photoIds[0]!) === item) last.photoIds.push(id);
    else out.push({ photoIds: [id], confidence: 0.9, reason: `boundary before ${id}` });
  }
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 40));

function delDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("autolister");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

let session: Session;

beforeEach(async () => {
  await delDb();
  window.localStorage.clear();
  session = buildSession();
  useAutolisterUploadStore.setState({
    sessionId: null,
    attached: false,
    tasks: [],
    results: [],
  });
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

describe("AutoLister scale v2 — 600 photos in, nothing lost (US-1910)", () => {
  it("builds the founder's session shape: 600 timeless photos, 45 items", () => {
    expect(session.photos).toHaveLength(TOTAL_PHOTOS);
    expect(session.items.size).toBe(ITEM_COUNT);
    expect(session.photos.every((p) => p.capturedAt === null)).toBe(true);
    // Every photo belongs to exactly one item, and the items partition the dump.
    const assigned = [...session.items.values()].flat();
    expect(new Set(assigned).size).toBe(TOTAL_PHOTOS);
  });

  // ── Leg 1: local auto-grouping (US-1540/US-1550) ───────────────────────

  it("auto-groups a no-EXIF dump without ever building a mega-group", () => {
    const groups = autoGroupPhotos(session.photos);

    // Nothing lost: the groups partition all 600 photos.
    const grouped = groups.flatMap((g) => g.photoIds);
    expect(grouped).toHaveLength(TOTAL_PHOTOS);
    expect(new Set(grouped).size).toBe(TOTAL_PHOTOS);
    // The US-1550 guard: one contiguous 600-photo filename run must NOT become
    // one boundary-free group, and no group may exceed the cap.
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) {
      expect(g.photoIds.length).toBeLessThanOrEqual(MAX_AUTO_GROUP_PHOTOS);
      expect(g.photoIds).toContain(g.coverId);
    }
    // Local grouping is conservative on a timeless dump (dHash + a bounded
    // ordinal window only) — it never bleeds two items together, which is what
    // makes the AI propose pass below a safe refinement rather than a repair.
    for (const g of groups) {
      const distinctItems = new Set(g.photoIds.map((id) => session.itemOf.get(id)));
      expect(distinctItems.size).toBe(1);
    }
  });

  // ── Leg 2: AI propose-groups across windows (US-1904) ──────────────────

  it("recovers all 45 items from AI boundary proposals across window seams", () => {
    const ids = session.photos.map((p) => p.id);
    const windows = planProposeWindows(ids);

    // Every window is one server-sized request, and the walk covers the dump.
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(PROPOSE_WINDOW);
    expect(new Set(windows.flat()).size).toBe(TOTAL_PHOTOS);

    const merged = mergeProposalWindows(
      windows.map((w) => fakeProposeGroups(w, session.itemOf)),
    );

    // Nothing lost, nothing duplicated across the seams.
    const proposed = merged.flatMap((g) => g.photoIds);
    expect(proposed).toHaveLength(TOTAL_PHOTOS);
    expect(new Set(proposed).size).toBe(TOTAL_PHOTOS);
    // Seam-spanning items are stitched back into one group, so the merge
    // reproduces the ground-truth 45 items exactly — in shooting order.
    expect(merged).toHaveLength(ITEM_COUNT);
    expect(merged.map((g) => g.photoIds)).toEqual([...session.items.values()]);
  });

  // ── Leg 3: verify covers EVERY group (US-1903) ─────────────────────────

  it("verifies every one of the 45 groups within the server's sample budget", () => {
    const groups = [...session.items.entries()].map(([id, photoIds]) => ({
      id,
      photoCount: photoIds.length,
    }));
    const windows = planVerifyWindows(groups);

    // The pre-US-1903 single call would have covered only the first ~13 groups.
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) {
      const sampled = w.reduce((s, g) => s + sampledSizeForVerify(g.photoCount), 0);
      expect(sampled).toBeLessThanOrEqual(MAX_VERIFY_SAMPLE_PHOTOS);
    }
    // FULL coverage: every group is checked exactly once, none skipped.
    const covered = windows.flat().map((g) => g.id);
    expect(covered).toHaveLength(ITEM_COUNT);
    expect(new Set(covered)).toEqual(new Set(groups.map((g) => g.id)));

    // Suggestions aggregate across windows and de-duplicate — the same merge
    // pair seen from two windows collapses to one row for the workbench.
    const suggestions = dedupeSuggestions([
      { type: "merge" as const, group_ids: ["item-00", "item-01"], photo_ids: ["photo-001"] },
      { type: "merge" as const, group_ids: ["item-01", "item-00"], photo_ids: ["photo-001"] },
      { type: "split" as const, group_ids: ["item-02"], photo_ids: ["photo-030"] },
    ]);
    expect(suggestions).toHaveLength(2);
  });

  // ── Leg 4: triage the verified session (US-1907) ───────────────────────

  it("triages the 45-group session for the workbench strip", () => {
    const groups: TriageGroup[] = [...session.items.entries()].map(([id, photoIds]) => ({
      id,
      photoIds,
      coverId: photoIds[0]!,
      roles: session.roles,
    }));
    const summary = computeTriage(
      groups,
      [{ type: "merge", group_ids: ["item-00", "item-01"] }],
      0,
      MAX_AUTO_GROUP_PHOTOS,
    );

    expect(summary.totalGroups).toBe(ITEM_COUNT);
    expect(summary.totalPhotos).toBe(TOTAL_PHOTOS);
    expect(summary.ungroupedCount).toBe(0);
    // Every item shot the full role cycle, so each has a tag + a valid cover.
    expect(summary.buckets.missing_cover_or_tag).toEqual([]);
    expect(summary.buckets.singleton).toEqual([]);
    // The oversized bucket surfaces exactly the items past the cap — the ones
    // a seller must eyeball, rather than the whole 45.
    const trulyOversized = [...session.items.entries()]
      .filter(([, ids]) => ids.length > MAX_AUTO_GROUP_PHOTOS)
      .map(([id]) => id);
    expect(summary.buckets.oversized).toEqual(trulyOversized);
    expect(summary.buckets.oversized.length).toBeGreaterThan(0);
    expect(summary.buckets.has_suggestion).toEqual(["item-00", "item-01"]);
  });

  // ── Leg 5: survive a mid-session reload (US-1905) ──────────────────────

  it("restores groups and resumes a queued upload after a mid-session reload", async () => {
    const sessionId = "session-1910";
    const groups = [...session.items.entries()].map(([id, photoIds]) => ({ id, photoIds }));

    // Mid-session: the workbench has grouped, and one upload is still queued
    // when the tab reloads.
    await saveSession(sessionId, {
      staged: session.photos,
      groups,
      undo: null,
      sort: { ungroupedSort: "filename", groupEvery: 6 },
      updatedAt: Date.now(),
    });
    const pending = new File(["bytes-of-IMG_0601"], "IMG_0601.JPG", {
      type: "image/jpeg",
      lastModified: 1_700_000_000_000,
    });
    await putBlob({
      taskId: "task-IMG_0601",
      sessionId,
      sig: fileSig(pending),
      name: pending.name,
      type: pending.type,
      blob: pending,
      createdAt: Date.now(),
    });

    // ── reload ── nothing in memory survives; everything comes back from IDB.
    useAutolisterUploadStore.setState({
      sessionId: null,
      attached: false,
      tasks: [],
      results: [],
    });

    const restored = await loadSession(sessionId);
    expect(restored).not.toBeNull();
    expect(restored!.staged).toHaveLength(TOTAL_PHOTOS); // all 600 photos back
    expect(restored!.groups).toHaveLength(ITEM_COUNT);
    expect(restored!.sort).toEqual({ ungroupedSort: "filename", groupEvery: 6 });

    // The queued upload resumes rather than being silently lost.
    await useAutolisterUploadStore.getState().resumeUploads(sessionId);
    const state = useAutolisterUploadStore.getState();
    expect(state.results).toHaveLength(1);
    expect(_transport.upload).toHaveBeenCalledTimes(1);
    await flush();
  });
});
