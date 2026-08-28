import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { uprightPassNote } from "@/components/flipdesk/measurement-photo-editor";

// US-2890 AC5: the seller is told their photo was moved, and how to move it
// back.
//
// The note is the ONLY place the seller learns this happened. The rotation is
// server-side and silent by construction: it runs during intake, writes new
// bytes over the same storage path, and the next time anyone opens the item the
// picture is simply the right way up. Without this string, "why is my photo
// different" has no answer anywhere in the product.
//
// So the two things worth pinning are that it says nothing when nothing
// happened - the overwhelmingly common case, and a note that fires on every
// item is a note nobody reads - and that when it does fire it names the undo.

describe("uprightPassNote", () => {
  it("says nothing when the pass never ran", () => {
    expect(uprightPassNote(null)).toBeNull();
  });

  it("says nothing when the pass ran and rotated nothing", () => {
    expect(uprightPassNote({ rotated: [], ranAt: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(uprightPassNote({ ranAt: "2026-01-01T00:00:00Z" })).toBeNull();
  });

  it("names the undo, because the note is the only place it is offered", () => {
    const note = uprightPassNote({
      rotated: [{ photoId: "p1", turns: 1, message: "x" }],
    });
    expect(note).toContain("Revert to original");
  });

  it("counts correctly rather than always saying 'a photo'", () => {
    const one = uprightPassNote({ rotated: [{ photoId: "p1", turns: 1, message: "x" }] });
    const two = uprightPassNote({
      rotated: [
        { photoId: "p1", turns: 1, message: "x" },
        { photoId: "p2", turns: 3, message: "y" },
      ],
    });
    expect(one).toContain("A photo was");
    expect(two).toContain("2 photos were");
  });

  it("says WHY the photo moved, not just that it did", () => {
    // "Your photo was rotated" invites "by what, and can I trust it". Naming the
    // MeasureCard is what makes the answer checkable by the seller.
    const note = uprightPassNote({ rotated: [{ photoId: "p1", turns: 2, message: "x" }] });
    expect(note).toContain("MeasureCard");
  });
});

describe("the key the note reads is the key the server writes", () => {
  it("matches UPRIGHT_PASS_KEY in the edge service", () => {
    // Two string literals in two runtimes that must be equal. The failure is
    // silent in the worst way: the server records the rotation, the panel reads
    // a key nobody writes, and the seller is never told - which looks exactly
    // like a pass that correctly decided to do nothing.
    const web = readFileSync(
      resolve(process.cwd(), "src/components/flipdesk/measurement-photo-editor.tsx"),
      "utf8",
    );
    const edge = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/measure-upright-pass.ts"),
      "utf8",
    );
    const webKey = web.match(/UPRIGHT_PASS_KEY\s*=\s*"([^"]+)"/)?.[1];
    const edgeKey = edge.match(/UPRIGHT_PASS_KEY\s*=\s*"([^"]+)"/)?.[1];
    expect(webKey, "no UPRIGHT_PASS_KEY in the editor").toBeTruthy();
    expect(edgeKey, "no UPRIGHT_PASS_KEY in the edge pass").toBeTruthy();
    expect(webKey).toBe(edgeKey);
  });
});
