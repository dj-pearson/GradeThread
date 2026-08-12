// US-1567 AC5: the composer embeds the SHARED PhotoManager (one photo editor
// for drafts and items), and a retag + delete round-trip through the mocked
// network seam.
import { describe, expect, it } from "vitest";
import { composerAll } from "@/lib/__tests__/helpers/composer-source";

import {
  persistRetag,
  persistDelete,
  type PhotoMutationClient,
} from "@/lib/photo-mutations";

interface Call {
  kind: string;
  table?: string;
  patch?: unknown;
  id?: string;
  paths?: string[];
}

function mockClient(opts: { updateError?: unknown; deleteError?: unknown } = {}) {
  const calls: Call[] = [];
  const client: PhotoMutationClient = {
    from(table) {
      return {
        update(patch) {
          return {
            eq: (_col, id) => {
              calls.push({ kind: "update", table, patch, id });
              return Promise.resolve({ error: opts.updateError ?? null });
            },
          };
        },
        delete() {
          return {
            eq: (_col, id) => {
              calls.push({ kind: "delete", table, id });
              return Promise.resolve({ error: opts.deleteError ?? null });
            },
          };
        },
      };
    },
    storage: {
      from(bucket) {
        return {
          remove: (paths) => {
            calls.push({ kind: "storage-remove", table: bucket, paths });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
  return { client, calls };
}

describe("PhotoManager mutation seams (US-1567)", () => {
  it("retag round-trips the photo_type update to item_photos by id", async () => {
    const { client, calls } = mockClient();
    await persistRetag(client, { id: "p1" }, "back");
    expect(calls).toEqual([
      {
        kind: "update",
        table: "item_photos",
        // US-2462: photo_role is written on EVERY retag, including as null.
        patch: { photo_type: "back", photo_role: null },
        id: "p1",
      },
    ]);
  });

  it("retag CLEARS a stale role when the new type takes none", async () => {
    // The bug this prevents: a photo tagged "Fabric close-up"
    // (detail, role 'fabric') retagged to "Front" would keep role='fabric' if
    // the update omitted the column — and the grading fabric check counts
    // role='fabric', so a front shot would go on satisfying it (US-2467).
    const { client, calls } = mockClient();
    await persistRetag(client, { id: "p1" }, "front", null);
    expect(calls[0]).toMatchObject({ patch: { photo_type: "front", photo_role: null } });
  });

  it("retag writes the role when the new type takes one", async () => {
    const { client, calls } = mockClient();
    await persistRetag(client, { id: "p1" }, "detail", "fabric");
    expect(calls[0]).toMatchObject({
      patch: { photo_type: "detail", photo_role: "fabric" },
    });
  });

  it("retag surfaces a server error instead of silently succeeding", async () => {
    const { client } = mockClient({ updateError: new Error("RLS") });
    await expect(persistRetag(client, { id: "p1" }, "front")).rejects.toThrow();
  });

  it("delete removes the storage object THEN the row", async () => {
    const { client, calls } = mockClient();
    await persistDelete(client, {
      id: "p2",
      storage_path: "u/i/back_1.jpg",
      photo_url: "https://cdn.test/u/i/back_1.jpg",
    });
    expect(calls).toEqual([
      { kind: "storage-remove", table: "item-photos", paths: ["u/i/back_1.jpg"] },
      { kind: "delete", table: "item_photos", id: "p2" },
    ]);
  });

  it("delete removes a private photo's object from the private bucket", async () => {
    // US-2407: a phone-captured tag carries photo_url "" and lives in
    // submission-images. Removing it from item-photos deleted nothing.
    const { client, calls } = mockClient();
    await persistDelete(client, {
      id: "p4",
      storage_path: "u/i/tag_1.jpg",
      photo_url: "",
    });
    expect(calls).toEqual([
      { kind: "storage-remove", table: "submission-images", paths: ["u/i/tag_1.jpg"] },
      { kind: "delete", table: "item_photos", id: "p4" },
    ]);
  });

  it("delete skips storage for rows without a path and still deletes the row", async () => {
    const { client, calls } = mockClient();
    await persistDelete(client, { id: "p3", storage_path: null, photo_url: "" });
    expect(calls).toEqual([{ kind: "delete", table: "item_photos", id: "p3" }]);
  });
});

describe("composer embeds the shared photo toolkit (US-1567)", () => {
  // US-2263: the photo toolkit moved into its own section component, and the
  // save payload into src/lib/composer-save.ts. `composerAll` spans the page and
  // every section, so these assertions follow the markup rather than the file.
  const composerSrc = composerAll;

  it("renders PhotoManager + PhotoUploader + MeasurementForm — not a bespoke strip", () => {
    expect(composerSrc).toContain("<PhotoManager");
    expect(composerSrc).toContain("<PhotoUploader");
    expect(composerSrc).toContain("<MeasurementForm");
    // The old duplicate order-writers are gone: item_photos.sort_order has
    // ONE owner on this page (PhotoManager).
    expect(composerSrc).not.toContain("function ComposerPhoto");
    expect(composerSrc).not.toContain("persistOrder");
  });

  // US-2501: the uploader is still mounted (it owns the bulk "Add photos"
  // button, the required-set badge and the "photographed" status advance) but
  // its per-tag slot grids are off. Those tiles rendered only the FIRST photo
  // of each tag, so a seller with three fabric macros saw one tile and a "×N"
  // sitting directly above a PhotoManager grid showing all three — two views of
  // one set, one of them lossy. Tagging happens in the grid below now.
  it("mounts the uploader WITHOUT its slot grid (US-2501)", () => {
    expect(composerAll).toContain("showSlots={false}");
  });

  it("keeps the primary-photo pick and the live-listing sync contract", () => {
    expect(composerSrc).toContain("onPickPrimary={setPrimaryPhotoId}");
    // The live-listing id is resolved by the page and handed down, so the
    // gallery re-sync still only fires for a genuinely live listing.
    expect(composerSrc).toContain("liveListingId={liveListingId}");
    expect(composerSrc).toMatch(
      /liveListingId=\{isLiveListing \? \(listing\?\.id \?\? null\) : null\}/,
    );
  });

  // US-2248 moved the payload assembly into src/lib/composer-save.ts, so the
  // reviewed_at stamp is now asserted on the real payload rather than by
  // grepping for a literal — see buildDraftListingPayload in
  // src/lib/__tests__/composer-save.test.ts. What still has to hold HERE is that
  // the composer feeds the builder a timestamp at all.
  it("stamps reviewed_at on save (US-1568: the draft leaves the AI queue)", () => {
    expect(composerSrc).toContain("reviewedAt: new Date().toISOString()");
  });
});
