import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-3240.
//
// photo-uploader.tsx deleted a listing photo straight off a 12px trash icon --
// no confirm, no undo, and sitting beside an "Add another" button the same
// size. It removed the storage OBJECTS first and the item_photos row second, so
// there was nothing left for a database restore to point at, and the garment is
// often packed, shipped or sold by the time anyone notices.
//
// useConfirm() has existed since US-437 and is provided to every authed page by
// ConfirmProvider. A dozen FlipDesk surfaces already use it for smaller things
// -- ending an eBay campaign, discarding a bulk intake. This guard is about the
// ones that delete a customer's own content.
//
// SCOPE: customer-facing components and pages only. Admin destructive actions
// are an operator deleting operator data, with a different (and lower) cost of
// a mistake, and they are not what this file is about.

const ROOTS = ["src/components/flipdesk", "src/components/submission", "src/pages/flipdesk"];

/**
 * Deliberate un-gated deletes, each with the reason it is safe. Shrink-only in
 * spirit: an entry that stops matching is a rename to notice, not a pass.
 */
const ALLOWED: { file: string; why: string }[] = [
  {
    file: "src/components/flipdesk/snap-catalog.tsx",
    why:
      "discardDraft() deletes only an un-enriched placeholder row, scoped by " +
      ".eq('title', DRAFT_TITLE), and its button already reads Discard. " +
      "There is no customer content to lose.",
  },
];

function listFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) {
        out.push(p.split(sep).join("/"));
      }
    }
  };
  for (const r of ROOTS) walk(resolve(process.cwd(), r));
  return out.map((p) => p.slice(p.indexOf("src/")));
}

/** A supabase row delete or an HTTP DELETE. */
const DESTRUCTIVE = /\.delete\(\)|method:\s*["']DELETE["']/;
/** Any confirmation mechanism: the hook, or an explicit dialog step. */
const GATED = /useConfirm\b|await\s+confirm\(|<AlertDialog|ConfirmDialog/;

describe("deleting a customer's own content asks first (US-3240)", () => {
  const files = listFiles();

  it("found files to check, and the allowlist still matches real ones", () => {
    expect(files.length).toBeGreaterThan(40);
    const stale = ALLOWED.filter((a) => !files.includes(a.file)).map((a) => a.file);
    expect(
      stale,
      `these are on the allowlist but no longer exist -- rename or delete the entry:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
    // The pattern must match the shape it claims to.
    expect(DESTRUCTIVE.test('const r = await fetch(u, { method: "DELETE" });')).toBe(true);
    expect(DESTRUCTIVE.test('supabase.from("item_photos").delete()')).toBe(true);
    expect(GATED.test("const confirm = useConfirm();")).toBe(true);
  });

  it("every destructive component has a confirmation mechanism", () => {
    const allowed = new Set(ALLOWED.map((a) => a.file));
    const offenders = files
      .filter((rel) => {
        if (allowed.has(rel)) return false;
        const src = readFileSync(resolve(process.cwd(), rel), "utf8");
        return DESTRUCTIVE.test(src) && !GATED.test(src);
      })
      .sort();
    expect(
      offenders,
      "these delete something and never ask. If the delete is genuinely safe, " +
        "add it to ALLOWED with the reason; otherwise gate it on " +
        "await confirm({ destructive: true }) with copy that says what is " +
        "lost:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the photo delete gate is inside remove(), before the delete", () => {
    // File-level matching is not enough here and the first version of this
    // test proved it: deleting the useConfirm import still left `await
    // confirm(` elsewhere in the file, so the guard passed against code that
    // no longer asked. What has to be true is narrower -- the confirm sits
    // INSIDE remove(), ahead of the storage call that makes it irreversible.
    const src = readFileSync(
      resolve(process.cwd(), "src/components/flipdesk/photo-uploader.tsx"),
      "utf8",
    );
    const start = src.indexOf("async function remove(");
    expect(start, "remove() has been renamed — update this guard").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf(String.fromCharCode(10) + "  }", start));

    const gateAt = body.indexOf("await confirm(");
    // US-3381: matched as a REGEX, not a literal. The call gained an error
    // check and wrapped onto three lines, which made the one-line literal
    // miss and this guard report that remove() no longer touches storage.
    const storageAt = body.search(/\.from\(\s*"item-photos"\s*\)\s*\.remove\(/);
    expect(gateAt, "remove() no longer asks before deleting").toBeGreaterThan(-1);
    expect(storageAt).toBeGreaterThan(-1);
    expect(
      gateAt < storageAt,
      "the confirm must come BEFORE the storage delete — after it, the file " +
        "is already gone and the dialog is theatre",
    ).toBe(true);

    // Generic "Are you sure?" copy is why people click through confirms. This
    // one has to carry the two facts a seller needs.
    expect(body).toMatch(/cannot be undone/i);
    expect(body).toMatch(/destructive:\s*true/);
  });
});
