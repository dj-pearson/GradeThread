// US-2382: no surface may WRITE a listings column that nothing reads.
//
// The history this guards against is specific and worth stating, because the
// mistake was an inference, not a typo. `listings.badge_enabled` (00027) and
// `listings.slab_image_mode` (00180) drove a grade badge burned onto the hero
// photo and a QR "digital slab" attached to the gallery. The 2026-06-25 policy
// decision retired both — a marketplace can suspend an account over a
// third-party grading mark on a listing PHOTO, and the same grade travels for
// free as description text, a "Condition Grade" item specific, and a cert
// number the buyer types at /verify. See
// vault/30-platform/grade-authority-on-listings.md.
//
// What survived the retirement was the columns sitting in publish's SELECT
// list. US-2247 read that SELECT, concluded "publish has always read
// badge_enabled and slab_image_mode", and shipped a composer switch that wrote
// both. Nothing branched on either value. A seller could flip "Add a grade card
// image to the gallery", save, publish, and get no card and no error — the
// worst shape a feature can have, because it also spends the seller's trust.
//
// BEING FETCHED IS NOT BEING USED. That is the reusable lesson, and this test
// is the mechanical version of it: a column with no reader may not be written.
// US-2382 removed the switch rather than wiring it, because a generated grade
// CARD added to the gallery is still a listing photo carrying a grading mark —
// the exact thing the policy bans.
//
// This is a source scan, not a runtime assertion, because the write could
// reappear on any of a dozen save paths and only a scan sees all of them at
// once. Scoped to WRITE positions: an object-literal key, which is what every
// supabase-js .insert()/.update()/.upsert() payload in this repo is built from.
// A SELECT string like "id, badge_enabled, ..." is a read and does not match.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Columns that exist on a table but have no reader anywhere in the product.
 * Their migrations are immutable, so the columns cannot be dropped cheaply;
 * what CAN be held is the rule that nobody writes them.
 *
 * This list may only GROW when a real dead column is found, and an entry may
 * only leave it when the column gains a genuine reader — one that BRANCHES on
 * the value, not one that merely names it in a SELECT.
 */
const DEAD_COLUMNS = ["badge_enabled", "slab_image_mode"] as const;

const ROOTS = ["src", "services/edge-functions/src", "functions"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r)).map((f) =>
  relative(process.cwd(), f).split(sep).join("/"),
);

/**
 * An object-literal write position: the column name at the start of a line
 * (allowing indentation), followed by a colon and a value. That is the shape
 * of every supabase payload key in this repo.
 *
 * Deliberately NOT matched: `badge_enabled` inside a quoted SELECT string, and
 * `badge_enabled: boolean | null` in a TYPE declaration — the first is a read
 * and the second declares a shape. The type-declaration exclusion is why the
 * value side must not be a bare TypeScript type.
 */
function writeSites(src: string, column: string): string[] {
  const re = new RegExp(`^[\\t ]*${column}\\s*:\\s*(.+)$`, "gm");
  const hits: string[] = [];
  for (const m of src.matchAll(re)) {
    const value = (m[1] ?? "").trim();
    // A type declaration: `boolean | null;`, `string | null;`, `SlabImageMode;`
    const isTypeDecl = /^(boolean|string|number|SlabImageMode)(\s*\|\s*null)?;?$/
      .test(value);
    if (!isTypeDecl) hits.push(m[0].trim());
  }
  return hits;
}

describe("no dead-column writes (US-2382)", () => {
  for (const column of DEAD_COLUMNS) {
    it(`nothing writes listings.${column}`, () => {
      const offenders: string[] = [];
      for (const file of FILES) {
        // The guard cannot flag its own documentation of the ban.
        if (file.endsWith("src/test/no-dead-column-writes.test.ts")) continue;
        for (const site of writeSites(readFileSync(file, "utf8"), column)) {
          offenders.push(`${file}: ${site}`);
        }
      }
      expect(
        offenders,
        `listings.${column} has no reader. Writing it stores a value nothing ` +
          `acts on, which is how US-2247 shipped a switch that silently did ` +
          `nothing. If you are adding a reader, remove the column from ` +
          `DEAD_COLUMNS in the same commit and say what reads it.\n` +
          offenders.join("\n"),
      ).toEqual([]);
      // Each case re-reads the whole scanned corpus, which takes ~2s alone and
      // ~7s when the full suite is running in parallel — over vitest's 5s
      // default. It failed on a TIMEOUT in a full run while passing in
      // isolation, which is the worst way for a guard to fail: it looks like a
      // real finding, it is not reproducible, and the next person learns to
      // re-run rather than to read it.
    }, 30_000);
  }

  // Vacuity guard. If the walker stops finding files -- a moved root, a broken
  // glob, a changed cwd -- every assertion above passes on an empty set and the
  // ban silently stops being enforced. Assert the corpus, not the offences.
  it("actually scanned the product source", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.startsWith("src/lib/composer-save"))).toBe(true);
    expect(
      FILES.some((f) => f.startsWith("services/edge-functions/src/routes/")),
    ).toBe(true);
  });

  // The detector has to be able to FAIL, or the two assertions above prove
  // nothing. Feed it the exact write US-2247 shipped and require a hit, and
  // feed it the two shapes that must NOT trip it.
  it("detects a write but not a read or a type declaration", () => {
    const write = "    badge_enabled: state.badgeEnabled,";
    const read = '      "id, listing_title, badge_enabled, quantity",';
    const decl = "  badge_enabled: boolean | null;";
    expect(writeSites(write, "badge_enabled")).toHaveLength(1);
    expect(writeSites(read, "badge_enabled")).toHaveLength(0);
    expect(writeSites(decl, "badge_enabled")).toHaveLength(0);
  });
});
