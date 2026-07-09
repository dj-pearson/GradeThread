// US-1768: structured, checkable brand authentication tells.
// brand-authenticity.ts imports supabase (getEffectiveTells), so set dummy env
// before the dynamic import even though the tested functions are pure.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  coerceTell,
  normalizeTells,
  validateTellsForWrite,
  mergeTells,
  getSeedTells,
  isAuthTellCategory,
} = await import("../lib/brand-authenticity.ts");

// ── coerceTell ───────────────────────────────────────────────────────────
Deno.test("coerceTell: a legacy free-text string becomes an 'other' tell", () => {
  const t = coerceTell("Zipper is YKK-branded");
  assert(t !== null);
  assertEquals(t!.category, "other");
  assertEquals(t!.claim, "Zipper is YKK-branded");
  assertEquals(t!.check, "");
  assertEquals(t!.confidence, 0.6);
});

Deno.test("coerceTell: a structured object is kept and confidence clamped", () => {
  const t = coerceTell({
    category: "date_code",
    claim: "Stamped, not printed",
    check: "Look under the tab",
    redFlag: "printed sticker",
    confidence: 5,
  });
  assertEquals(t!.category, "date_code");
  assertEquals(t!.redFlag, "printed sticker");
  assertEquals(t!.confidence, 1, "confidence clamps to [0,1]");
});

Deno.test("coerceTell: legacy {tell, detail} shape maps to claim/check", () => {
  const t = coerceTell({ tell: "Even stitching", detail: "5 stitches per section" });
  assertEquals(t!.claim, "Even stitching");
  assertEquals(t!.check, "5 stitches per section");
});

Deno.test("coerceTell: unknown category falls back to 'other'; empty claim → null", () => {
  assertEquals(coerceTell({ category: "bogus", claim: "x" })!.category, "other");
  assertEquals(coerceTell({ claim: "   " }), null);
  assertEquals(coerceTell(42), null);
});

// ── normalizeTells ─────────────────────────────────────────────────────────
Deno.test("normalizeTells: mixed array, drops junk, non-array → []", () => {
  const out = normalizeTells(["a tell", { claim: "b" }, 7, null, { nope: 1 }]);
  assertEquals(out.length, 2);
  assertEquals(out[0].claim, "a tell");
  assertEquals(out[1].claim, "b");
  assertEquals(normalizeTells("not an array"), []);
});

// ── validateTellsForWrite ──────────────────────────────────────────────────
Deno.test("validateTellsForWrite: rejects a non-array (can't wipe the column with a typo)", () => {
  const r = validateTellsForWrite({ claim: "x" });
  assert(!r.ok);
});

Deno.test("validateTellsForWrite: rejects an entry with no claim, naming the index", () => {
  const r = validateTellsForWrite([{ claim: "ok" }, { check: "no claim here" }]);
  assert(!r.ok);
  assert((r as { error: string }).error.includes("[1]"));
});

Deno.test("validateTellsForWrite: canonicalizes categories + confidence", () => {
  const r = validateTellsForWrite([{ category: "weird", claim: "c", confidence: -2 }]);
  assert(r.ok);
  assertEquals(r.tells[0].category, "other");
  assertEquals(r.tells[0].confidence, 0);
});

// ── mergeTells ─────────────────────────────────────────────────────────────
Deno.test("mergeTells: DB tells win over a seed tell with the same claim", () => {
  const db = [{ category: "serial", claim: "Creed patch", check: "read it", confidence: 0.9 }];
  const seed = [
    { category: "other", claim: "creed  patch", check: "seed", confidence: 0.3 }, // same claim (norm)
    { category: "hardware", claim: "Solid brass", check: "weigh it", confidence: 0.5 },
  ];
  const merged = mergeTells(db as never, seed as never);
  assertEquals(merged.length, 2, "the duplicate claim collapses; the new seed tell stays");
  assertEquals(merged[0].check, "read it", "DB entry is authoritative and comes first");
  assertEquals(merged[1].claim, "Solid brass");
});

// ── seed + category guard ──────────────────────────────────────────────────
Deno.test("getSeedTells: tier-1 brands ship grounded seed tells; unknown → []", () => {
  assert(getSeedTells("louisvuitton").length > 0);
  assert(getSeedTells("coach").some((t) => t.category === "serial"));
  assertEquals(getSeedTells("no-such-brand"), []);
});

Deno.test("isAuthTellCategory guards the known set", () => {
  assert(isAuthTellCategory("hardware"));
  assert(!isAuthTellCategory("nonsense"));
  assert(!isAuthTellCategory(3));
});
