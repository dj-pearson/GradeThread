// US-3363 (AC3/AC5): no write in flipdesk-sync.ts may drop its result.
//
// The column bug is what got found; the unchecked result is what let it run.
// `.update({ listing_status: "sold", sold_at: sale.soldAt })` had been
// answering HTTP 400 PGRST204 on every confirmed sale since US-2697 shipped,
// and the route returned `status: "ok"` each time, because the statement was a
// bare `await` with nothing on the left of it.
//
// This counts rather than sampling. `body.includes("throw")` is satisfied by
// one guard beside two queries -- the fix is writes === checked, so deleting
// any one of them is red. And a captured error that nothing then reads is the
// same defect wearing a destructure, so each binding has to be USED near the
// call as well.
//
//   deno test --allow-read src/tests/sync-writes-checked_test.ts
import { assert, assertEquals } from "@std/assert";

const ROUTE_REL = "services/edge-functions/src/routes/flipdesk-sync.ts";
const RAW = Deno.readTextFileSync(
  new URL("../routes/flipdesk-sync.ts", import.meta.url),
).replace(/\r\n/g, "\n");

/**
 * Code with comments blanked out, LINE NUMBERS AND OFFSETS PRESERVED.
 *
 * Block comments are stripped as blocks first: filtering by line prefix leaves
 * the interior of a `/* ... *\/`, whose continuation lines start with plain
 * prose -- and the note beside a write is exactly where that write gets quoted.
 * This file's own header quotes the defect, so a scan that read comments would
 * be reading itself.
 */
function codeOnly(src: string): string {
  const blanked = src.replace(
    /\/\*[\s\S]*?\*\//g,
    (m) => m.replace(/[^\n]/g, " "),
  );
  return blanked.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const SRC = codeOnly(RAW);

interface Write {
  line: number;
  verb: string;
  /** The name the statement bound the error to, if it bound one at all. */
  binding: string | null;
  /** Is that name mentioned again after the statement? */
  read: boolean;
}

const DECLARATION = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s*$/;

function writes(): Write[] {
  const out: Write[] = [];
  for (const m of SRC.matchAll(/\.(update|insert|upsert)\(/g)) {
    const at = m.index!;
    const owner = SRC.lastIndexOf("supabaseAdmin", at);
    if (owner === -1) continue;
    // A `.update()` on something that is not the service-role client is not
    // this file's business.
    if (SRC.slice(owner, at).includes(";")) continue;

    const lineStart = SRC.lastIndexOf("\n", owner) + 1;
    const prelude = SRC.slice(lineStart, owner);
    const decl = DECLARATION.exec(prelude);

    let binding: string | null = null;
    if (decl) {
      for (const part of decl[1]!.split(",")) {
        const [name, alias] = part.split(":").map((s) => s.trim());
        if (name === "error") binding = alias || name;
      }
    }

    // Where the statement ends: the first `;` at bracket depth zero.
    let depth = 0;
    let end = at;
    for (let i = at; i < SRC.length; i++) {
      const ch = SRC[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    const after = SRC.slice(end, end + 600);
    const read = binding !== null &&
      new RegExp(`\\b${binding}\\b`).test(after);

    out.push({
      line: SRC.slice(0, at).split("\n").length,
      verb: m[1]!,
      binding,
      read,
    });
  }
  return out;
}

const WRITES = writes();

Deno.test("US-3363: the scan finds every write in the route", () => {
  // Without a floor, a regex that stopped matching would read as a file with
  // no unchecked writes in it -- which is how a scan quietly stops guarding.
  assertEquals(
    WRITES.length,
    10,
    `expected 10 service-role writes in ${ROUTE_REL}, found ${WRITES.length}: ` +
      `${WRITES.map((w) => `${w.line} ${w.verb}`).join(", ")}. A new write is ` +
      `fine -- add it to this count deliberately, having checked its result.`,
  );
  assertEquals(
    WRITES.filter((w) => w.verb === "update").length,
    4,
    "the four .update() calls are the sold flip, the claim's listing_url, and " +
      "the resolve and dismiss of a review row",
  );
});

Deno.test("US-3363: every write binds its error", () => {
  const bare = WRITES.filter((w) => w.binding === null);
  assertEquals(
    bare.map((w) => `${ROUTE_REL}:${w.line} ${w.verb}`),
    [],
    "a write is a bare `await` with nothing on the left of it. PostgREST " +
      "returns a 400 in the body, not as a thrown exception, so an uncaptured " +
      "result is a failure nobody can see -- that is how US-3363's PGRST204 " +
      "ran on every confirmed sale while the route answered 200.",
  );
});

Deno.test("US-3363: every bound error is then READ", () => {
  const ignored = WRITES.filter((w) => w.binding !== null && !w.read);
  assertEquals(
    ignored.map((w) => `${ROUTE_REL}:${w.line} binds ${w.binding} and drops it`),
    [],
    "capturing an error and never looking at it is the same defect with extra " +
      "syntax",
  );
});

Deno.test("US-3363: the scan can actually fail (self-check)", () => {
  // The shape that shipped, and the shape that replaced it, put through the
  // same parser. Without this pair a rule that stopped firing is silent.
  const broken = codeOnly(`
      await supabaseAdmin
        .from("listings")
        .update({ listing_status: "sold" })
        .eq("id", id);
      return c.json({ ok: true });
  `);
  const fixed = codeOnly(`
      const { error: soldErr } = await supabaseAdmin
        .from("listings")
        .update({ listing_status: "sold" })
        .eq("id", id);
      if (soldErr) console.error(soldErr.message);
  `);
  const captured = codeOnly(`
      const { error: soldErr } = await supabaseAdmin
        .from("listings")
        .update({ listing_status: "sold" })
        .eq("id", id);
      return c.json({ ok: true });
  `);

  const scanOf = (src: string) => {
    const m = /\.(update|insert|upsert)\(/.exec(src)!;
    const at = m.index!;
    const owner = src.lastIndexOf("supabaseAdmin", at);
    const prelude = src.slice(src.lastIndexOf("\n", owner) + 1, owner);
    const decl = DECLARATION.exec(prelude);
    let binding: string | null = null;
    if (decl) {
      for (const part of decl[1]!.split(",")) {
        const [name, alias] = part.split(":").map((s) => s.trim());
        if (name === "error") binding = alias || name;
      }
    }
    const end = src.indexOf(";", src.indexOf(".eq(", at));
    const after = src.slice(end, end + 600);
    return {
      binding,
      read: binding !== null && new RegExp(`\\b${binding}\\b`).test(after),
    };
  };

  assertEquals(scanOf(broken).binding, null, "a bare await reads as checked");
  assertEquals(scanOf(captured).read, false, "a dropped binding reads as read");
  assertEquals(scanOf(fixed).binding, "soldErr");
  assertEquals(scanOf(fixed).read, true, "a used binding reads as unread");
});

Deno.test("US-3363: this file's own prose cannot satisfy it", () => {
  // Mode 1 of guards-that-do-not-guard, pinned: the header above quotes the
  // defective statement verbatim, so the comment stripper is load-bearing.
  // A token that appears ONLY in the route's prose, never in its code -- so a
  // sabotage that reinstates the defect reddens the rules above rather than
  // this control, which would say something misleading.
  const PROSE_ONLY = "PGRST204";
  assert(
    RAW.includes(PROSE_ONLY),
    "the route's header no longer explains the defect; if that is deliberate, " +
      "this control is obsolete",
  );
  assert(
    !SRC.includes(PROSE_ONLY),
    "the comment stripper let the route's own header through, so the scan is " +
      "reading documentation as code",
  );
  // And real code survives the strip, or the scan above is reading nothing.
  assert(SRC.includes("sold_at: sale.soldAt,"), "the stripper ate real code");
  // Offsets must survive the strip or every line number reported above is a lie.
  assertEquals(SRC.length, RAW.length);
  assertEquals(SRC.split("\n").length, RAW.split("\n").length);
});
