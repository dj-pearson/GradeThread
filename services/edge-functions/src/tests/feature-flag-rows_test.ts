// US-2653: every declared kill-switch has a row an operator can reach.
//
// THE DEFECT. `FeatureKey` declares 15 switches. Four had no row in
// public.feature_flags: forensic_grade, passport_forecast,
// trial_conversion_drip, inventory_equity. That is not cosmetic —
//
//   • GET /api/admin/feature-flags lists ROWS, ordered by key, so the console
//     showed nothing for them;
//   • PUT /api/admin/feature-flags answers 404 "Unknown feature flag" when
//     there is no row, so the toggle could not be used even by someone who knew
//     the key by heart;
//   • there is no create endpoint.
//
// So the only way to disable those four was a hand-written INSERT against
// production, during whatever incident made you want to. Three of them promise
// the opposite in their own comments — "disabled platform-wide without a
// redeploy", "an ops kill-switch", "the admin builder's kill flips it off so
// every replica hard-stops".
//
// WHY THE UNION IS THE SOURCE AND THE SEED IS THE THING CHECKED: a key can only
// be passed to isFeatureEnabled if it is in the union, so the union is the
// complete set of switches the code believes in. The rows are what makes each
// one operable. Any key in the first and not the second is a switch that exists
// only in the type system.

import { assert, assertEquals } from "@std/assert";

const FLAGS_SRC = await Deno.readTextFile(
  new URL("../lib/feature-flags.ts", import.meta.url),
);
const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);

/** Every key in the FeatureKey union. */
function declaredKeys(): string[] {
  // ⚠ STRIP COMMENTS FIRST, THEN find the terminating semicolon. The other
  // order truncates the union at a semicolon inside a comment — this exact
  // union was once cut from 15 keys to 5 that way, and the scratch script that
  // found this defect walked into it again before being fixed.
  const commentless = FLAGS_SRC
    .split(/\r?\n/)
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");
  const at = commentless.indexOf("export type FeatureKey =");
  assert(at > -1, "the FeatureKey union was renamed or removed");
  const end = commentless.indexOf(";", at);
  assert(end > at, "could not find the end of the FeatureKey union");
  return [...commentless.slice(at, end).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
}

/** Every key any migration seeds into public.feature_flags. */
function seededKeys(): Set<string> {
  const out = new Set<string>();
  for (const entry of Deno.readDirSync(MIGRATIONS)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const sql = Deno.readTextFileSync(new URL(entry.name, MIGRATIONS));
    if (!/insert\s+into\s+public\.feature_flags/i.test(sql)) continue;
    // MATCH THE TUPLE, NOT THE STATEMENT. The first version sliced from the
    // INSERT to the next semicolon and read every quoted string inside — and a
    // semicolon in a DESCRIPTION ("gates on this; off hard-stops every
    // replica") truncated it, so 00607's last entry read as unseeded. Third
    // time today a semicolon inside quoted text or a comment has ended a match
    // early. A flag row is always `('key', true|false,` so anchoring on the
    // boolean cannot be fooled by punctuation anywhere else.
    for (const m of sql.matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*(?:true|false)\s*,/gi)) {
      out.add(m[1]!);
    }
  }
  return out;
}

Deno.test("US-2653: every declared feature key has a seeded row", () => {
  const declared = declaredKeys();
  assert(declared.length >= 12, `only ${declared.length} keys parsed from the union`);
  const seeded = seededKeys();
  const unreachable = declared.filter((k) => !seeded.has(k)).sort();
  assertEquals(
    unreachable,
    [],
    "these kill-switches have no row, so the admin console does not list them " +
      "and the toggle endpoint answers 404. Seed them in a migration — a switch " +
      "that can only be flipped by hand-written SQL during an incident is not a " +
      "switch.",
  );
});

Deno.test("US-2653: the seed does not invent keys the code cannot use", () => {
  // The other direction. A seeded key absent from the union is a row in the
  // console that gates nothing: an operator flips it, the UI confirms, and the
  // feature keeps running. Named exemptions only.
  const KNOWN_NON_UNION: Record<string, string> = {
    waitlist_gating:
      "00165: read through its own helper rather than isFeatureEnabled, because the gate runs before a user exists and the FeatureKey path resolves a plan.",
  };
  const declared = new Set(declaredKeys());
  const stray = [...seededKeys()].filter(
    (k) => !declared.has(k) && !(k in KNOWN_NON_UNION),
  ).sort();
  assertEquals(
    stray,
    [],
    "these rows exist but no FeatureKey names them, so flipping them in the " +
      "console does nothing. Either add the key or add a named exemption.",
  );
  for (const [key, why] of Object.entries(KNOWN_NON_UNION)) {
    assert(why.length > 40, `${key} needs a real reason for its exemption`);
  }
});

Deno.test("US-2653: seeding stayed behaviour-neutral", () => {
  // The four added in 00607 are all read FAIL-OPEN today, and a missing row
  // already resolves to enabled — so seeding enabled=true changes nothing at
  // runtime. Seeding one of them `false` would be a product change wearing
  // plumbing, so the migration is pinned to the neutral value.
  const sql = Deno.readTextFileSync(
    new URL("00607_seed_missing_feature_flags.sql", MIGRATIONS),
  );
  for (const key of [
    "forensic_grade",
    "passport_forecast",
    "trial_conversion_drip",
    "inventory_equity",
  ]) {
    assert(
      new RegExp(`'${key}',\\s*true`).test(sql),
      `${key} must be seeded enabled=true; anything else changes behaviour`,
    );
  }
  assert(
    /on conflict \(key\) do nothing/i.test(sql),
    "an operator override must survive a re-run, as 00096's seed does",
  );
});
