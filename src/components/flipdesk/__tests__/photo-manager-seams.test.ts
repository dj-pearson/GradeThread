// US-1567 AC5: the composer embeds the SHARED PhotoManager (one photo editor
// for drafts and items), and a retag + delete round-trip through the mocked
// network seam.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      { kind: "update", table: "item_photos", patch: { photo_type: "back" }, id: "p1" },
    ]);
  });

  it("retag surfaces a server error instead of silently succeeding", async () => {
    const { client } = mockClient({ updateError: new Error("RLS") });
    await expect(persistRetag(client, { id: "p1" }, "front")).rejects.toThrow();
  });

  it("delete removes the storage object THEN the row", async () => {
    const { client, calls } = mockClient();
    await persistDelete(client, { id: "p2", storage_path: "u/i/back_1.jpg" });
    expect(calls).toEqual([
      { kind: "storage-remove", table: "item-photos", paths: ["u/i/back_1.jpg"] },
      { kind: "delete", table: "item_photos", id: "p2" },
    ]);
  });

  it("delete skips storage for rows without a path and still deletes the row", async () => {
    const { client, calls } = mockClient();
    await persistDelete(client, { id: "p3", storage_path: null });
    expect(calls).toEqual([{ kind: "delete", table: "item_photos", id: "p3" }]);
  });
});

describe("composer embeds the shared photo toolkit (US-1567)", () => {
  const composerSrc = readFileSync(
    join(process.cwd(), "src/pages/flipdesk/composer.tsx"),
    "utf8",
  );

  it("renders PhotoManager + PhotoUploader + MeasurementForm — not a bespoke strip", () => {
    expect(composerSrc).toContain("<PhotoManager");
    expect(composerSrc).toContain("<PhotoUploader");
    expect(composerSrc).toContain("<MeasurementForm");
    // The old duplicate order-writers are gone: item_photos.sort_order has
    // ONE owner on this page (PhotoManager).
    expect(composerSrc).not.toContain("function ComposerPhoto");
    expect(composerSrc).not.toContain("persistOrder");
  });

  it("keeps the primary-photo pick and the live-listing sync contract", () => {
    expect(composerSrc).toContain("onPickPrimary={setPrimaryPhotoId}");
    expect(composerSrc).toMatch(/liveListingId=\{isLiveListing \? listing\?\.id : null\}/);
  });

  it("stamps reviewed_at on save (US-1568: the draft leaves the AI queue)", () => {
    expect(composerSrc).toContain("reviewed_at: new Date().toISOString()");
  });
});
