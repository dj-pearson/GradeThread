// US-3068: the evidence pack answered from a return id.
//
// The verdict logic is US-2705's and is tested there. What is asserted here is
// the part this story adds: turning a planner context into something an overlay
// can render, and refusing to answer at all for a return this workspace does
// not own.
//
// THE REFUSAL IS THE POINT OF THE FEATURE, not an edge case. A pack that would
// argue from a defect the listing never disclosed is a pack that proves the
// buyer right, so it must not assemble and must offer nothing to copy.
import assert from "node:assert/strict";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const { isPlausibleReturnId, shieldAnswerFrom } = await import("../lib/return-shield.ts");
type Ctx = Parameters<typeof shieldAnswerFrom>[0];

function ctx(over: Record<string, unknown> = {}): Ctx {
  return {
    plan: {
      verdict: "supported",
      reason: "every complained-of defect was disclosed",
      mayAutoAssemble: true,
      citations: [
        {
          defectIndex: 0,
          defectType: "pilling",
          location: "underarm",
          severity: "minor",
          reportText: "Light pilling under both arms.",
          disclosedIn: "description",
          disclosureQuote: "Light pilling under the arms.",
        },
      ],
    },
    hasSnapshot: true,
    stamp: { certificateNumber: "GT-1234", overallScore: 8.5, gradeTier: "Excellent" },
    gradedAt: "2026-08-01T00:00:00.000Z",
    defectCount: 3,
    ...over,
  } as Ctx;
}

Deno.test("US-3068: a supported pack assembles and carries its citations", () => {
  const out = shieldAnswerFrom(ctx());
  assert.equal(out.verdict, "assemble");
  assert.equal(out.certificateNumber, "GT-1234");
  assert.equal(out.defectCount, 3);
  assert.equal(out.hasPublicationSnapshot, true);
  assert.equal(out.citations?.length, 1);
});

Deno.test("US-3068: a pack that would prove an undisclosed flaw REFUSES", () => {
  // US-2703's constraint, and the whole reason this surface is safe to build:
  // arguing from a defect the listing never disclosed argues for the buyer.
  const out = shieldAnswerFrom(
    ctx({
      plan: {
        verdict: "undisclosed",
        reason: "the complained-of defect was never disclosed",
        mayAutoAssemble: false,
        citations: [],
      },
    }),
  );
  assert.equal(out.verdict, "refuse-undisclosed");
});

Deno.test("US-3068: a refusal offers NOTHING to copy, even if the planner listed citations", () => {
  // The dangerous shape: a planner that refuses but still returns citations
  // would put a Copy button in front of a seller for text that argues against
  // them. The answer strips them regardless of what the plan carried.
  const out = shieldAnswerFrom(
    ctx({
      plan: {
        verdict: "undisclosed",
        reason: "not disclosed",
        mayAutoAssemble: false,
        citations: ctx()!.plan.citations,
      },
    }),
  );
  assert.equal(out.verdict, "refuse-undisclosed");
  assert.deepEqual(out.citations, [], "a refusal handed the seller something to paste");
});

Deno.test("US-3068: no context is no-report, which is an answer and not an error", () => {
  // planEvidence returns null for a return with no graded item, no submission,
  // no report and no recorded defects. All four mean the same thing to a
  // seller: there is nothing here to argue with. Dressing it as a failure would
  // put a retry in front of a pack that will never exist.
  const out = shieldAnswerFrom(null);
  assert.equal(out.verdict, "no-report");
  assert.equal(out.certificateNumber, undefined);
  assert.equal(out.citations, undefined);
});

Deno.test("US-3068: the answer never carries the buyer's complaint", () => {
  // AC5 applies the US-9111 untrusted-string rule to overlay copy. The
  // genuinely untrusted string on an eBay return page is what the BUYER wrote,
  // and it is the one thing that must not travel to a surface we render.
  const json = JSON.stringify(shieldAnswerFrom(ctx()));
  assert.ok(!/complaint/i.test(json), json);
  assert.ok(!/reason/i.test(json), `the plan's reason text reached the answer: ${json}`);
});

Deno.test("US-3068: an implausible return id is refused before it reaches a query", () => {
  assert.equal(isPlausibleReturnId("5012345678"), true);
  assert.equal(isPlausibleReturnId("RET-abc_123"), true);
  for (const bad of [
    "",
    " ",
    "a".repeat(65),
    "has space",
    "semi;colon",
    "quote'",
    "../../etc",
    42,
    null,
    undefined,
    {},
  ]) {
    assert.equal(isPlausibleReturnId(bad), false, `${JSON.stringify(bad)} was accepted`);
  }
});

Deno.test("US-3068: the route is mounted where an extension token is accepted", () => {
  // ⚠ THE STORY'S AC2 NAMES A MOUNT THAT WOULD REFUSE THE EXTENSION.
  // /api/flipdesk/ebay/* runs ebayAuthMiddleware, which falls through to
  // authMiddleware — a user JWT. The extension holds an extension token, so the
  // route lives on its own mount with extensionOrUserAuthMiddleware, the same
  // one the extension queue uses and for the same reason.
  const main = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
  assert.match(
    main,
    /app\.use\("\/api\/flipdesk\/return-shield\/\*", extensionOrUserAuthMiddleware\);/,
    "the return shield is not behind extensionOrUserAuthMiddleware, so the " +
      "extension's token would be refused",
  );
  assert.match(main, /app\.route\("\/api\/flipdesk\/return-shield", flipdeskReturnShieldRoutes\);/);

  // And it must NOT have been hung off the eBay mount, where that middleware
  // does not apply.
  assert.ok(
    !/flipdeskReturnShieldRoutes\)[\s\S]{0,40}flipdesk\/ebay/.test(main),
    "the return shield is mounted under /api/flipdesk/ebay, which refuses an extension token",
  );
});

Deno.test("US-3068: there is still ONE planner", () => {
  // US-2707's rule. A return, a payment dispute and this shield are the same
  // question from three surfaces; a second planner would be a second answer,
  // and the rarer path would hold the one nobody re-checked.
  const shield = Deno.readTextFileSync(new URL("../lib/return-shield.ts", import.meta.url));
  assert.match(shield, /import \{ type EvidenceContext, planEvidence \} from "\.\/evidence-plan\.ts";/);
  assert.ok(
    !/buildEvidencePlan|matchComplaint/.test(shield),
    "the return shield builds its own plan instead of calling the one planner",
  );

  // And the extracted planner is what the eBay route uses too, rather than a
  // copy left behind.
  const ebay = Deno.readTextFileSync(new URL("../routes/flipdesk-ebay.ts", import.meta.url));
  assert.match(ebay, /from "\.\.\/lib\/evidence-plan\.ts"/);
  assert.ok(
    !/async function planEvidence\(/.test(ebay),
    "flipdesk-ebay.ts kept its own copy of planEvidence after the extraction",
  );
});

Deno.test("US-3068: the route sends nothing to eBay", () => {
  // AC4. Sending the pack stays on the FlipDesk post-sale surface where the
  // eBay API does it behind a separate click. This surface answers a question.
  const route = Deno.readTextFileSync(
    new URL("../routes/flipdesk-return-shield.ts", import.meta.url),
  );
  for (const forbidden of ["fetch(", "FormData", "ebayFetch", "/evidence"]) {
    assert.ok(
      !route.includes(forbidden),
      `the return-shield route contains ${forbidden}; it must only read`,
    );
  }
});
