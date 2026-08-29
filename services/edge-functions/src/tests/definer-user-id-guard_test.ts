// US-3008: a SECURITY DEFINER function that takes a user id must guard its BODY.
//
// THE SHAPE THIS CATCHES, and it has now shipped twice:
//
//   CREATE FUNCTION public.do_something(p_user_id uuid, ...)
//   SECURITY DEFINER
//   AS $$ BEGIN DELETE FROM ... WHERE user_id = p_user_id; ... END; $$;
//
// SECURITY DEFINER runs as the owner, so RLS does not apply and the only thing
// deciding who may act on p_user_id is the function itself. If the body does
// not check, any caller who can reach the function can act on ANY user's rows.
//
// ⚠ AND THE GRANT DOES NOT SAVE IT. `CREATE FUNCTION` grants EXECUTE to PUBLIC
// by default. A later `grant execute ... to service_role` ADDS a grant; it does
// not remove the default one. Only a REVOKE removes it — and a REVOKE is
// exactly what must never be written on this Postgres image, because a DENIED
// call from anon or authenticated restarts the whole database (US-2403). So on
// this stack the grant CANNOT be the control, and the body has to be.
//
// That combination is what makes the mistake so easy: the author does the right
// thing by not revoking, writes a grant that reads like a restriction, and ends
// up with a function anyone can call with anyone's id.
//
// HISTORY, so nobody reads this as hypothetical:
//   00685  rebuild_ledger_for_user  — shipped to PRODUCTION with no body guard.
//                                     Fixed by 00686 after the fact.
//   00688  take_inventory_snapshot  — same shape, caught by reading the file
//                                     before it was applied. Fixed in place.
//
// WHAT IT DOES NOT DO. It cannot tell a real check from a decorative one; it
// looks for evidence that the parameter is compared against the caller, or that
// the caller's role is checked. A function that "checks" and then ignores the
// result passes. That is the usual limit of a source scan and is worth stating
// rather than implying.
import { assertEquals } from "@std/assert";

const MIGRATIONS_DIR = new URL(
  "../../../../supabase/migrations/",
  import.meta.url,
);

/**
 * Functions that take a user id, are SECURITY DEFINER, and legitimately do not
 * guard — with the reason.
 *
 * Shrink-only in spirit: an entry that stops matching is dead weight and should
 * be removed with the fix. Adding one means arguing that nothing bad happens
 * when an arbitrary caller passes an arbitrary id, which is a high bar.
 */
const ALLOWED = new Map<string, string>([
  [
    "00685_ledger_entries.sql|public.rebuild_ledger_for_user",
    "SUPERSEDED BY 00686, which added the body guard after this shipped to " +
      "production without one. Listed because this guard reads migration " +
      "SOURCE and an applied migration is immutable — NOT because the shape is " +
      "acceptable. It is the exact defect the test exists for.",
  ],
]);

/**
 * Only migrations AFTER the sweep.
 *
 * US-2282 measured the whole surface on 2026-08-21 — 96 SECURITY DEFINER
 * functions in production, 55 reachable by anon, 40 already guarded — and
 * 00640 closed the remaining 13. The triage is in
 * vault/20-domain/security-definer-exposure.md.
 *
 * Scanning before that point reports 31 findings, nearly all of them ORIGINAL
 * definitions that a later migration has already re-emitted with a guard. A
 * guard that fails at 31 on history is a guard someone switches off, which is
 * the failure mode rls-guard_test.ts names in its own SWEEP comment and the one
 * this repo keeps hitting.
 *
 * ⚠ THE SWEEP DID NOT HOLD, which is why this test exists at all. 00685 shipped
 * an unguarded function to production four days after 00640 closed the last
 * one, and 00688 repeated it. A one-off sweep fixes the instances; only a check
 * on every commit fixes the class.
 */
const SWEEP = "00640";

/** A parameter that names a user. Deliberately narrow. */
const USER_ID_PARAM = /\b(p_user_id|user_id|p_uid|target_user_id)\s+uuid/i;

/**
 * Evidence that the body decides who may act, rather than trusting the caller.
 *
 * Either arm counts: comparing the parameter against auth.uid() (the "only your
 * own" shape), or gating on the role (the "service role only" shape). Both
 * appear in the fixes this guard exists to keep.
 */
const GUARDED = [
  /auth\.uid\(\)/i,
  /auth\.role\(\)/i,
  /current_setting\(\s*'request\.jwt/i,
];

interface Finding {
  file: string;
  fn: string;
}

/** Every `CREATE [OR REPLACE] FUNCTION ... $$ ... $$;` block in one file. */
function functionBlocks(sql: string): { name: string; block: string }[] {
  const out: { name: string; block: string }[] = [];
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\)\s*returns[\s\S]*?\$(\w*)\$([\s\S]*?)\$\3\$\s*;/gi;
  for (const m of sql.matchAll(re)) {
    out.push({ name: m[1], block: m[0] });
  }
  return out;
}

Deno.test("US-3008: a SECURITY DEFINER function taking a user id guards its body", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();

  const unguarded: Finding[] = [];

  for (const name of names) {
    if (name.slice(0, 5) <= SWEEP) continue;
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
    for (const { name: fn, block } of functionBlocks(sql)) {
      if (!/security\s+definer/i.test(block)) continue;

      // The parameter list only, so a `user_id` column reference inside the
      // body does not make every function look like it takes one.
      const params = block.slice(block.indexOf("("), block.indexOf(")") + 1);
      if (!USER_ID_PARAM.test(params)) continue;

      if (ALLOWED.has(`${name}|${fn}`)) continue;
      if (GUARDED.some((re) => re.test(block))) continue;

      unguarded.push({ file: name, fn });
    }
  }

  assertEquals(
    unguarded.map((u) => `${u.file}: ${u.fn}`),
    [],
    "SECURITY DEFINER function(s) take a user id and never check who is asking. " +
      "RLS does not apply inside SECURITY DEFINER, and the GRANT cannot be the " +
      "control on this image: CREATE FUNCTION grants EXECUTE to PUBLIC, a " +
      "targeted grant only ADDS to that, and a REVOKE restarts the database " +
      "(US-2403). Put the check in the body — 00686 and 00688 both show the " +
      "shape — or add it to ALLOWED with an argument for why an arbitrary " +
      "caller passing an arbitrary id is harmless.",
  );
});

Deno.test("US-3008: the guard still detects the shape it was written for", () => {
  // A source scan that stops matching is indistinguishable from a clean tree,
  // so the pattern is exercised against the exact code that shipped in 00685
  // before 00686 fixed it. If this stops firing, the test above is decorative.
  const sabotage = `
CREATE OR REPLACE FUNCTION public.rebuild_ledger_for_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.ledger_entries WHERE user_id = p_user_id;
  RETURN 0;
END;
$$;
`;
  const blocks = functionBlocks(sabotage);
  assertEquals(blocks.length, 1, "the block matcher stopped finding functions");

  const block = blocks[0].block;
  const params = block.slice(block.indexOf("("), block.indexOf(")") + 1);
  assertEquals(/security\s+definer/i.test(block), true);
  assertEquals(USER_ID_PARAM.test(params), true, "the user-id parameter stopped matching");
  assertEquals(
    GUARDED.some((re) => re.test(block)),
    false,
    "an unguarded body now reads as guarded — the check has gone soft",
  );
});
