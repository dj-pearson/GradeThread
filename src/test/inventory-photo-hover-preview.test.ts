import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Hover-to-enlarge on the Inventory table's cover thumbnails.
//
// Source-scan guard (same style as grid-image-lazy.test.ts). Two things must
// stay true, and both are the kind of thing a later edit breaks silently:
//
//   (a) the 40px thumbnail is still wrapped in the hover preview, and
//   (b) the preview renders from the THUMBNAIL, not the full-res original —
//       `displayWidth={320}` matches the stored ~320w thumbnail_url (US-413),
//       so opening a preview costs zero extra bytes. A `full` here would pull a
//       multi-MB original on every hover.

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const TABLE = "src/pages/flipdesk/listings-table.tsx";
const PREVIEW = "src/components/flipdesk/item-photo-hover-preview.tsx";

describe("inventory cover thumbnail hover preview", () => {
  it("wraps the inventory table's cover thumbnail in the hover preview", () => {
    const src = read(TABLE);
    expect(src).toContain(
      'import { ItemPhotoHoverPreview } from "@/components/flipdesk/item-photo-hover-preview"',
    );
    const open = src.indexOf("<ItemPhotoHoverPreview");
    const close = src.indexOf("</ItemPhotoHoverPreview>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(src.slice(open, close)).toContain("<ItemPhotoImg");
  });

  it("previews from the stored thumbnail, never the full-res original", () => {
    const src = read(PREVIEW);
    expect(src).toContain("displayWidth={320}");
    expect(src).not.toMatch(/\bfull\b\s*(=|\}|\/>)/);
  });

  it("lets clicks pass through to the row underneath", () => {
    expect(read(PREVIEW)).toContain("pointer-events-none");
  });
});
