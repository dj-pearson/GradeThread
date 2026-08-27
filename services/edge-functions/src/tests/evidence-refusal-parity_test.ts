// US-2707 AC2: the rarer path is not the one where the safety rule is missing.
//
// Returns and payment disputes are two eBay surfaces asking the same question -
// does the grade report back this seller - and they are answered by two route
// handlers hundreds of lines apart. The failure this guards is not a crash. It
// is the dispute path quietly assembling a pack the return path would have
// refused, because a rule added to one was never added to the other.
//
// That has a name in this repo: lib/pending-delists.ts and the
// EXTENSION_DELIST_PLATFORMS drift. Both were "just remember to do it in both
// places".
//
// A source guard rather than a request test, because the behaviour it protects
// is already unit-tested in dispute-evidence_test.ts - buildEvidencePlan is the
// thing that decides. What is NOT covered by that is whether both routes ask
// it, and that is what this checks.

import { assert, assertEquals } from "@std/assert";

const ROUTE = new URL("../routes/flipdesk-ebay.ts", import.meta.url);

/** Comments stripped: a paragraph about a refusal is not a refusal. */
function code(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const src = code(Deno.readTextFileSync(ROUTE));

/** The body of one route handler, by brace matching from its mount. */
function handlerFor(path: string): string | null {
  const at = src.indexOf(`flipdeskEbayRoutes.post("${path}"`);
  if (at === -1) return null;
  const open = src.indexOf("{", src.indexOf("async (c) =>", at));
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

const PATHS = {
  returns: "/returns/:returnId/evidence",
  disputes: "/payment-disputes/:id/evidence",
  // US-2935 added the third surface — an escalated eBay case, the one that
  // costs a defect. It is exactly the "rarer path" this guard exists for.
  cases: "/cases/:caseId/evidence",
};

Deno.test("US-2707: the guard can parse both handlers", () => {
  // Without this a rename leaves both bodies null and every assertion below
  // vacuously true — the failure mode that makes source guards worthless.
  for (const [name, path] of Object.entries(PATHS)) {
    const body = handlerFor(path);
    assert(body, `could not parse the ${name} evidence handler (${path})`);
    assert(
      body.length > 500,
      `${name} parsed as ${body.length} characters — that is not a handler body`,
    );
  }
});

Deno.test("US-2707 AC2: EVERY evidence path refuses a supported verdict", () => {
  // ⚠ WIDENED IN US-2935, and the reason matters more than the change.
  //
  // This used to require the literal `verdict === "supported"` inside each
  // handler. That was a proxy for "this handler refuses", correct until the
  // refusal moved into ONE shared arbiter (lib/evidence-send.ts
  // evidenceRefusalFor) — at which point the guard failed on code that was
  // strictly safer than the code it was written against.
  //
  // The proxy is now: each handler builds a plan AND hands it to the shared
  // arbiter. What the arbiter then does is pinned by evidence-send_test.ts,
  // including the direction that matters — a plan that could not be built is
  // NOT a refusal.
  const missing: string[] = [];
  for (const [name, path] of Object.entries(PATHS)) {
    const body = handlerFor(path) ?? "";
    const asksThePlanner = body.includes("planEvidence(");
    const refuses = body.includes("evidenceRefusalFor(");
    if (!asksThePlanner) missing.push(`${name}: never builds an evidence plan`);
    else if (!refuses) missing.push(`${name}: builds a plan and ignores the verdict`);
  }
  assertEquals(
    missing,
    [],
    "an evidence path can assemble a pack the others would refuse. When the " +
      "grade report documents a flaw the listing did not disclose, sending it " +
      "hands eBay a signed document proving our own user sold it undisclosed.",
  );
});

Deno.test("US-2935: ONE arbiter decides the refusal, not one per surface", () => {
  // The same argument as the single-planner test below, one layer up. Three
  // copies of "is this verdict supported" is three chances for the rarest
  // surface to keep an older answer.
  const arbiters = [...src.matchAll(/function evidenceRefusalFor\(/g)];
  assertEquals(
    arbiters.length,
    0,
    "the refusal arbiter must live in lib/evidence-send.ts, not in the route file",
  );
  const callers = [...src.matchAll(/evidenceRefusalFor\(/g)];
  assertEquals(
    callers.length,
    Object.keys(PATHS).length,
    `${callers.length} calls to the refusal arbiter for ${
      Object.keys(PATHS).length
    } evidence surfaces — every surface must ask, and nothing else should`,
  );
});

Deno.test("US-2707: one planner answers for both, not two that must agree", () => {
  // Two planners is two verdicts, and the one that drifts is the rarer path.
  //
  // COUNTED BY WHAT MAKES A PLANNER, not by its name. The first version of this
  // matched /async function planEvidence\(/ and sabotage walked straight past
  // it: a second planner would not be called planEvidence, because that name is
  // taken — it would be planEvidenceForDisputes, and the guard would have
  // reported one planner while two existed. A duplicate of the same name is a
  // TypeScript redeclaration error, so the name was the one thing that could
  // never go wrong.
  const planners = [...src.matchAll(/buildEvidencePlan\(/g)];
  assertEquals(
    planners.length,
    1,
    `${planners.length} places build an evidence plan in this file — there must ` +
      "be exactly one, or the two case types can reach different verdicts",
  );
});

Deno.test("US-2707 AC3: the pack does not override eBay's requested evidence type", () => {
  // eBay asked for a category of proof. Sending the pack under a type of our
  // choosing answers a different question from the one it asked, and an answer
  // filed against the wrong request reads as no answer at all.
  const body = handlerFor(PATHS.disputes) ?? "";
  assert(
    body.includes("request0?.requestType"),
    "the dispute path no longer derives the evidence type from the live dispute",
  );
  // The from-pack branch must not introduce its own evidenceType assignment.
  const assignments = [...body.matchAll(/evidenceType\s*=/g)];
  assertEquals(
    assignments.length,
    1,
    "the evidence type is assigned more than once — the pack is overriding " +
      "what eBay asked for",
  );
});

Deno.test("US-2707 AC1: the manual single-file upload still works without a pack", () => {
  // The from-pack fields are OPTIONAL. A caller that sends one file and no
  // order_id must behave exactly as it did before this story.
  const body = handlerFor(PATHS.disputes) ?? "";
  assert(
    /packOrderId && packComplaint/.test(body),
    "the from-pack branch is not gated on its own inputs, so the plain upload " +
      "path now depends on them",
  );
  // The single file is still uploaded on every path, pack or no pack.
  assert(
    body.includes("cleanBytes"),
    "the seller's own file is no longer uploaded",
  );
});
