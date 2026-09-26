// US-3521: refuse to grade on a prompt version that never passed the eval gate.
//
// The grading monitor already raises serving_unevaluated_prompt when a stage
// serves a version (the active row, or the code default by name) that fails
// checkPromptServingEligibility. This is the refusal half, and it is OFF by
// default for a reason recorded on the story: prod has no passing eval for
// either code default today, so enforcing now would stop every grade on the
// next deploy. Turn it on once the golden set is seeded and the defaults have
// passing rows.
//
//   GRADING_PROMPT_EVAL_GATE=enforce        refuse new grades (503, before any
//                                           charge) while a stage is unevaluated
//   GRADING_PROMPT_EVAL_GATE_OVERRIDE=<why> serve anyway; the reason is logged
//                                           on every check so it cannot hide
//
// Checked at boot and every 15 minutes, in the background, never throwing: a
// boot guard that can fail is how the schema check once crash-looped the edge
// (US-778). A failed check leaves the previous state in place.

// No import of grading-monitor.ts here: grading-availability.ts reads this
// module, and the provider that feeds the breaker imports that, so a static
// import back into the monitor would close a cycle. main.ts passes the finder.

export type Unevaluated = { stage: string; version: string; reason: string };

export interface PromptGateDecision {
  block: boolean;
  /** What to log, or null when there is nothing to say. */
  log: string | null;
}

/** Pure: whether to refuse grading given what is unevaluated and the env. */
export function promptGateDecision(
  unevaluated: readonly Unevaluated[],
  mode: string | undefined,
  override: string | undefined,
): PromptGateDecision {
  if (unevaluated.length === 0) return { block: false, log: null };
  const names = unevaluated.map((u) => `${u.stage}=${u.version}`).join(", ");
  const enforce = (mode ?? "").trim().toLowerCase() === "enforce";
  const why = (override ?? "").trim();
  if (!enforce) {
    return { block: false, log: `[prompt-gate] serving unevaluated prompt(s) ${names} (gate not enforced)` };
  }
  if (why) {
    return {
      block: false,
      log: `[prompt-gate] OVERRIDE: serving unevaluated prompt(s) ${names} because: ${why}`,
    };
  }
  return {
    block: true,
    log: `[prompt-gate] REFUSING new grades: unevaluated prompt(s) ${names}. ` +
      `Pass the eval gate, or set GRADING_PROMPT_EVAL_GATE_OVERRIDE with a reason.`,
  };
}

let blocked = false;

/** Read by grading-availability.ts on every submit. */
export function promptGateBlocked(): boolean {
  return blocked;
}

/** Test seam. */
export function _setPromptGateBlockedForTest(v: boolean): void {
  blocked = v;
}

export async function refreshPromptGate(
  find: () => Promise<Unevaluated[]>,
): Promise<void> {
  try {
    const decision = promptGateDecision(
      await find(),
      Deno.env.get("GRADING_PROMPT_EVAL_GATE"),
      Deno.env.get("GRADING_PROMPT_EVAL_GATE_OVERRIDE"),
    );
    blocked = decision.block;
    if (decision.log) {
      (decision.block ? console.error : console.warn)(decision.log);
    }
  } catch (err) {
    console.error("[prompt-gate] check failed; keeping the previous state:", err);
  }
}

export const PROMPT_GATE_REFRESH_MS = 15 * 60_000;
