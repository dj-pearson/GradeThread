// US-2755: which refusal wins when the plan gate and the AI quota are checked
// at the same time.
//
// WHY THIS EXISTS AS A NAMED RULE. The two checks used to run one after the
// other — plan gate, then quota — so a user failing BOTH saw the plan-gate
// refusal and never reached the quota check. Running them concurrently saves a
// round trip on every successful request, but it also means both answers now
// arrive together, and something has to decide which one the caller sees.
//
// Getting that wrong is not a crash. It is a seller on an expired plan being
// told "monthly AI limit reached" — a message about a different problem, with a
// different fix, that sends them to top up something they cannot use. The
// precedence is therefore pinned by a test rather than left implicit in the
// order of two if-statements.
//
// PLAN GATE FIRST, always. It is the more fundamental refusal: a quota only
// means anything inside a plan that grants one.

export type Refusal = "gate" | "quota" | null;

/**
 * Which refusal to return, given both answers.
 *
 * Deliberately takes booleans rather than the Response and the quota object, so
 * the rule is one line with no framework in it and the test reads as the rule
 * itself.
 */
export function whichRefusal(gateRefused: boolean, quotaOk: boolean): Refusal {
  if (gateRefused) return "gate";
  if (!quotaOk) return "quota";
  return null;
}
