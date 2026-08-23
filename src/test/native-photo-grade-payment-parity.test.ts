import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2815. The Android payment model is pinned to `POST /api/grade/pay/:id`
// because the first draft of it was WRONG in two ways at once: it guessed flat
// snake_case fields (`paid_from`, `credit_balance`) by paraphrasing the iOS
// model rather than reading the route. grade.ts nests everything under
// `payment` and names them in camelCase.
//
// Nothing would have failed loudly. A response that decodes to all-defaults
// reads as "not paid", so the app would have prompted people to buy credits
// they had just spent — after charging them.

const ROUTE = "services/edge-functions/src/routes/grade.ts";
const PRECEDENCE = "services/edge-functions/src/lib/grade-precedence.ts";
const KOTLIN = "android/app/src/main/java/com/gradethread/app/grading/PhotoGradePayment.kt";

/** Source with comments removed. Prose that NAMES a wrong value is not that
 *  value, and the file warning about a mistake is the one most likely to
 *  quote it. */
function code(src: string): string {
  // Line-based on purpose: no regex, so no backslash survives a shell round
  // trip. Kotlin doc comments open with /** and continue with *.
  return src
    .split(String.fromCharCode(10))
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith(String.fromCharCode(42)) &&
        !t.startsWith(String.fromCharCode(47, 42)) &&
        !t.startsWith(String.fromCharCode(47, 47));
    })
    .join(String.fromCharCode(10));
}

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** The body of the pay route, so assertions cannot match some other handler. */
function payRoute(): string {
  const src = read(ROUTE);
  const start = src.indexOf('gradeRoutes.post("/pay/:id"');
  expect(start, "the pay route was renamed").toBeGreaterThan(-1);
  const next = src.indexOf("gradeRoutes.", start + 20);
  return src.slice(start, next > start ? next : undefined);
}

describe("the payment reply is nested under `payment`, not flat", () => {
  it("the route really nests it", () => {
    // If this stops being true the Kotlin below is wrong in a way that decodes
    // silently to all-defaults, which reads as unpaid.
    expect(payRoute()).toContain("payment: {");
  });

  it("Kotlin decodes a nested payment object", () => {
    const kotlin = read(KOTLIN);
    expect(kotlin).toContain("val payment: Payment? = null");
    // CODE ONLY. The Kotlin doc comment NAMES the wrong field names as a
    // warning about them, and the first version of this assertion fired on
    // that warning - the guard reading the documentation written about it.
    expect(code(kotlin), "a flat snake_case guess came back").not.toContain("paid_from");
    expect(code(kotlin), "a flat snake_case guess came back").not.toContain("credit_balance");
  });
});

describe("every field the route can send is decodable", () => {
  const route = payRoute();

  for (const field of [
    "paid",
    "method",
    "newIncludedUsed",
    "newBalance",
    "checkoutRequired",
    "suggestedPack",
  ]) {
    it(`\`${field}\` is on both sides`, () => {
      expect(route, `the route no longer sends ${field}`).toContain(field);
      expect(read(KOTLIN), `Kotlin cannot decode ${field}`).toContain(field);
    });
  }
});

describe("the pack offer's own shape", () => {
  it("is credits + priceCents, camelCase", () => {
    // grade-precedence.ts declares it; a snake_case guess here would decode to
    // zeroes and offer someone a 0-credit pack for $0.00.
    const iface = read(PRECEDENCE);
    expect(iface).toContain("export interface PackOffer");
    expect(iface).toContain("priceCents: number;");
    const kotlin = read(KOTLIN);
    expect(kotlin).toContain("val credits: Int");
    expect(kotlin).toContain("val priceCents: Int");
  });
});

describe("an unrecognised method is treated as PAID, not unpaid", () => {
  it("the else branch pays from credits rather than prompting again", () => {
    // The route already said paid=true. Treating an unknown method name as
    // unpaid would ask someone to buy credits they had just spent — the same
    // wall they paid to clear.
    const kotlin = read(KOTLIN);
    const outcome = kotlin.slice(kotlin.indexOf("fun outcome()"));
    expect(outcome).toContain("if (!p.paid) return Outcome.NeedsCredits");
    expect(outcome).toContain("else -> Outcome.PaidFromCredits");
  });
});

describe("the terminal statuses match the pipeline", () => {
  it("Android knows all three", () => {
    // SCOPED TO THE SET. The first version searched the whole file and stayed
    // green when needs_photos was deleted from TERMINAL - because the same
    // string still appears in terminalMessage below. A status missing from the
    // set never stops the poll, so the app would spin forever on an abstain.
    const kotlin = read(KOTLIN);
    const set = kotlin.slice(kotlin.indexOf("val TERMINAL"));
    const decl = set.slice(0, set.indexOf(")") + 1);
    for (const status of ["completed", "needs_photos", "failed"]) {
      expect(decl, `${status} missing from TERMINAL`).toContain(`"${status}"`);
    }
  });

  it("the two no-charge outcomes say so", () => {
    // needs_photos and failed both refund. Saying it first is the difference
    // between a refusal and an apparent wasted purchase.
    const kotlin = read(KOTLIN);
    const messages = kotlin.slice(kotlin.indexOf("fun terminalMessage"));
    const notCharged = messages.split("You have not been charged.").length - 1;
    expect(notCharged, "a no-charge terminal state stopped saying so").toBe(2);
  });
});
