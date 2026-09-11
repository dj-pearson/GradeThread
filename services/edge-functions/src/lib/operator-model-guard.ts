// US-3184: an operator script must not spend prod AI calls on a model nobody chose.
//
// WHAT HAPPENED. On 2026-09-02, between 17:58 and 18:35, scripts/backfill-tag-reads.ts
// made 169 tag-OCR calls against production on claude-sonnet-4-6. Every tag_ocr
// call outside that 37-minute window ran on claude-sonnet-5. The script was run
// from a dev box with --env-file=services/edge-functions/.env, and that file
// still carried DEFAULT_AI_MODEL=claude-sonnet-4-6 from before the 2026-07-02
// flip. Nothing warned, because a previous-generation id is a REAL model: the
// calls succeeded, the data was written, and only the ledger knew.
//
// WHY THAT IS NOT JUST $2.78 OF WASTE. extractTagGroundTruth feeds
// tagGroundTruthBlock, which goes into the GRADING PROMPT as trusted ground
// truth. So a stale line in an untracked dev file quietly changed the model
// behind a grading input, on production, with no shadow compare and nothing
// recording that it had.
//
// THE GUARD IS ON THE PAIR (host, model), not on either alone. Running an old
// model against a local stack is how you reproduce an old result and is fine.
// Running one against prod is the thing that has no legitimate silent form.
//
// It is deliberately NOT a check that the model is "good". It compares against
// the code default, because that is the value the deployed service resolves to
// and therefore the only definition of "what this data would have been written
// with normally".

/** Hosts that are somebody's laptop rather than production. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal|.*\.local)$/i;

export function isLocalSupabaseHost(supabaseUrl: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(supabaseUrl).hostname);
  } catch {
    // An unparseable URL is not evidence of a local stack. Treat it as remote,
    // which is the direction that fails closed.
    return false;
  }
}

/**
 * One tier's verdict: what this process WILL send, and what the build expects.
 *
 * US-3184 follow-up. The first version of this guard took a single pair, which
 * hardcoded the assumption "an operator script spends on exactly one tier, and
 * that tier is the default one". That was true of the two scripts that existed
 * the day it was written, and it is the kind of true that expires: the same
 * stale .env that pinned DEFAULT_AI_MODEL also pins LIGHTWEIGHT_AI_MODEL, and
 * a script that starts making one lightweight call would have been waved
 * through on a banner that never mentioned the tier it drifted on.
 *
 * Build these with resolveOperatorModels() in ai-config.ts rather than by hand,
 * so the ids come from the same resolvers the service uses.
 */
export interface ModelResolution {
  /** Tier key, e.g. "default" - see MODEL_TIERS in ai-config.ts. */
  tier: string;
  /** The env var that changes this tier, named so the banner says where to look. */
  env: string;
  /** What this process will actually send as `model`. */
  resolved: string;
  /** What this build resolves to with the environment empty. */
  expected: string;
}

export interface ModelDriftCheck {
  /**
   * The SUPABASE_URL the script will write through, when it writes at all.
   *
   * OMIT IT for a script that spends AI but persists nothing - scripts/measure-eval.ts
   * is the case: it runs the measurement golden set out of a local directory and
   * prints a RELEASE GATE verdict. It writes no row, and it is still guarded,
   * because the output it produces is ATTRIBUTED to a model. A gate that passed
   * on a model nobody is running is not a gate. With no URL the check cannot
   * grant the local-stack exemption, so drift refuses until somebody says
   * otherwise - which is the right default for a number people will quote.
   */
  supabaseUrl?: string;
  /**
   * Every tier this script can spend on. Preferred over the single-pair form
   * below; src/tests/operator-script-model-guard_test.ts checks that the tiers
   * a script declares cover the resolvers its imports actually reach.
   */
  models?: readonly ModelResolution[];
  /** The model the script's calls will actually resolve to. Single-tier shorthand. */
  resolvedModel?: string;
  /** The model the deployed service would use - normally getDefaultModel()'s code default. */
  expectedModel?: string;
  /** Set by --allow-model-drift: the operator has said the mismatch is intended. */
  allowDrift?: boolean;
}

export interface ModelDriftVerdict {
  /** False means: do not make the calls. */
  ok: boolean;
  /** One line for the banner, always. */
  banner: string;
  /** Present only when ok is false. */
  refusal?: string;
}

/**
 * Decide whether an operator script may proceed, and what to print first.
 *
 * The banner prints on EVERY run, drift or not, and a dry run gets it too -
 * a dry run still pays for the OCR, which is the point of --limit. A script
 * that only speaks up when something is wrong teaches nobody what normal
 * looks like.
 *
 * Pure, so the four cases below are unit-testable without a network.
 */
export function checkModelDrift(input: ModelDriftCheck): ModelDriftVerdict {
  const models = normalizeModels(input);
  const local = input.supabaseUrl !== undefined &&
    isLocalSupabaseHost(input.supabaseUrl);
  let host = input.supabaseUrl ?? "no datastore";
  if (input.supabaseUrl !== undefined) {
    try {
      host = new URL(input.supabaseUrl).host;
    } catch {
      // keep the raw string; the banner is better with something than nothing
    }
  }

  const drifted = models.filter((m) => m.resolved !== m.expected);
  // One line per tier, drift or not. A banner that lists only the problem tier
  // leaves an operator unable to tell "checked and fine" from "never checked".
  const lines = models.map((m) =>
    `${models.length > 1 ? `${m.tier}=` : ""}${m.resolved}` +
    (m.resolved !== m.expected ? ` (expected ${m.expected}, via ${m.env})` : "")
  );
  const banner = `[operator] target=${host}${local ? " (local)" : ""} model=${
    lines.join(" ")
  }`;

  if (drifted.length === 0) return { ok: true, banner };
  if (local) return { ok: true, banner };
  if (input.allowDrift) {
    return {
      ok: true,
      banner: `${banner} -- proceeding on --allow-model-drift`,
    };
  }

  const detail = drifted
    .map((m) => `    ${m.env}: ${m.resolved}, build expects ${m.expected}`)
    .join("\n");
  return {
    ok: false,
    banner,
    refusal:
      `Refusing to run against ${host} on ${
        drifted.map((m) => m.resolved).join(", ")
      } when the deployed default is ${
        drifted.map((m) => m.expected).join(", ")
      }.\n${detail}\n` +
      `  This is what wrote 169 prod tag reads on a previous-generation model ` +
      `on 2026-09-02 (US-3184): a stale DEFAULT_AI_MODEL in a dev .env.\n` +
      `  Fix the env file, or pass --allow-model-drift if running this model ` +
      `against production is genuinely what you want.`,
  };
}

/**
 * Accept either shape, and refuse to check nothing.
 *
 * A guard handed an empty tier list would return ok:true and print a banner
 * with no model in it - which is the failure mode this whole story is about,
 * wearing the guard's own uniform. So that throws.
 */
function normalizeModels(input: ModelDriftCheck): readonly ModelResolution[] {
  if (input.models && input.models.length > 0) return input.models;
  if (input.resolvedModel !== undefined && input.expectedModel !== undefined) {
    return [{
      tier: "default",
      env: "DEFAULT_AI_MODEL",
      resolved: input.resolvedModel,
      expected: input.expectedModel,
    }];
  }
  throw new Error(
    "checkModelDrift: no models to check. Pass models: resolveOperatorModels([...]) " +
      "with the tiers this script spends on, or resolvedModel + expectedModel.",
  );
}
