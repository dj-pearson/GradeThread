// Worth My Time, R1 01/12 (US-3166): where a seller works, what they have to
// work with, and what their time is worth to them.
//
// Everything a plan is fitted to lives here. The planner that reads these is
// R1 06/12 onward; this module stores them and hands them back, and nothing
// else in the first release may widen that.
//
// ── THE FIRST-RELEASE CONTRACT (AC1), written where the code can see it ─────
// These are limits on the whole feature, not on this file, and they are here
// because a contract kept only in a story is one nobody re-reads:
//
//   SURFACE     Responsive FlipDesk web only. Native iOS and Android screens
//               are outside R1.
//   MONEY       USD estimates only, until currency conversion exists. The
//               currency is stored explicitly anyway, so the day conversion
//               arrives the stored rows are not ambiguous.
//   PLANNING    Rule-based. No new model calls. Not one.
//   AUTHORITY   Advisory. Nothing here ever lists, reprices, buys or disposes
//               of anything on its own.
//   LEARNING    Per-seller only. Cross-seller learning is R2 and outside this
//               release.
//
// ── WHY THERE IS NO SOURCING-TRIP MODE ──────────────────────────────────────
// It is the obvious third work context and it is deliberately absent. A plan
// is a list of tasks, and there is no task in R1 that can run in a thrift
// store aisle: measuring, photographing, steaming and packing all need the
// item in hand at a table. Shipping a mode with nothing to do in it teaches a
// seller the feature is empty. `phone_only` already covers the useful half --
// the seller is away from their table and can still do the screen work.

/** Where the seller is when they work. */
export const WORK_CONTEXTS = ["home", "phone_only"] as const;
export type WorkContext = (typeof WORK_CONTEXTS)[number];

/**
 * What the seller has to hand. Deliberately a small closed set: a tool only
 * belongs here if a task in R1 is gated on it, so an unknown string is a
 * mistake rather than an extension point.
 */
export const WORK_TOOLS = [
  "camera",
  "measuring_tape",
  "steamer",
  "packing_supplies",
] as const;
export type WorkTool = (typeof WORK_TOOLS)[number];

/** The quick picks the screen offers (R1 10/12). Custom values are also legal. */
export const SESSION_MINUTE_PRESETS = [15, 30, 60] as const;
export const MIN_SESSION_MINUTES = 5;
export const MAX_SESSION_MINUTES = 240;
export const DEFAULT_SESSION_MINUTES = 30;

/** R1 stores and reports USD only (AC1), and says so rather than assuming. */
export const SUPPORTED_CURRENCIES = ["USD"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Bumped when the MEANING of a stored field changes, so a later release can
 * tell a row it wrote from a row it inherited. Not a row version and not a
 * concurrency token -- updated_at is for that.
 */
export const SETTINGS_VERSION = 1;

export interface WorkPreferences {
  defaultSessionMinutes: number;
  workContext: WorkContext;
  availableTools: WorkTool[];
  /**
   * What an hour of the seller's time is worth to them, in whole dollars and
   * cents, or NULL when they have not said.
   *
   * NULL IS NOT ZERO AND THE DIFFERENCE IS THE POINT (AC3). A planner reading
   * zero would rank every task as infinitely worth doing; a planner reading
   * null knows it cannot rank on money at all and has to say so. The screen
   * shows "not set" rather than "$0.00" for the same reason.
   */
  hourlyTargetAmount: number | null;
  hourlyTargetCurrency: SupportedCurrency;
  settingsVersion: number;
}

/** What a seller who has never opened the screen gets. */
export function defaultWorkPreferences(): WorkPreferences {
  return {
    defaultSessionMinutes: DEFAULT_SESSION_MINUTES,
    workContext: "home",
    // Every phone is a camera, so this is the one tool it is safe to assume.
    // Assuming a tape measure or a steamer would put tasks in a plan that the
    // seller then cannot do, which is worse than offering too few.
    availableTools: ["camera"],
    hourlyTargetAmount: null,
    hourlyTargetCurrency: "USD",
    settingsVersion: SETTINGS_VERSION,
  };
}

export interface ValidationFailure {
  field: string;
  message: string;
}

/**
 * A partial update, validated field by field.
 *
 * PARTIAL IS THE WHOLE SHAPE OF THIS (AC6). The screen saves one control at a
 * time, so an absent key means "leave it alone" and an explicit null means
 * something only where null is a real value -- which is the hourly target and
 * nowhere else. Treating absent and null the same would make it impossible to
 * clear a target once set, or would clear it on every save of anything else.
 */
export interface WorkPreferencesPatch {
  defaultSessionMinutes?: number;
  workContext?: WorkContext;
  availableTools?: WorkTool[];
  hourlyTargetAmount?: number | null;
  hourlyTargetCurrency?: SupportedCurrency;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse and validate an update off a request body.
 *
 * Returns the patch to apply, or every reason it was refused -- all of them,
 * not the first. A screen that saves four controls at once should be told
 * about all four mistakes rather than made to discover them one round trip at
 * a time.
 */
export function parseWorkPreferencesPatch(
  body: unknown,
): { ok: true; patch: WorkPreferencesPatch } | {
  ok: false;
  errors: ValidationFailure[];
} {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      errors: [{ field: "body", message: "Expected a JSON object." }],
    };
  }
  const errors: ValidationFailure[] = [];
  const patch: WorkPreferencesPatch = {};

  if ("default_session_minutes" in body) {
    const raw = body.default_session_minutes;
    if (
      typeof raw !== "number" || !Number.isFinite(raw) ||
      !Number.isInteger(raw)
    ) {
      errors.push({
        field: "default_session_minutes",
        message: "Session length must be a whole number of minutes.",
      });
    } else if (raw < MIN_SESSION_MINUTES || raw > MAX_SESSION_MINUTES) {
      errors.push({
        field: "default_session_minutes",
        message:
          `Session length must be between ${MIN_SESSION_MINUTES} and ${MAX_SESSION_MINUTES} minutes.`,
      });
    } else {
      patch.defaultSessionMinutes = raw;
    }
  }

  if ("work_context" in body) {
    const raw = body.work_context;
    if (
      typeof raw !== "string" ||
      !(WORK_CONTEXTS as readonly string[]).includes(raw)
    ) {
      errors.push({
        field: "work_context",
        message: `Work context must be one of: ${WORK_CONTEXTS.join(", ")}.`,
      });
    } else {
      patch.workContext = raw as WorkContext;
    }
  }

  if ("available_tools" in body) {
    const raw = body.available_tools;
    if (!Array.isArray(raw)) {
      errors.push({
        field: "available_tools",
        message: "Tools must be a list.",
      });
    } else {
      const bad = raw.filter(
        (t) => typeof t !== "string" || !(WORK_TOOLS as readonly string[]).includes(t),
      );
      if (bad.length > 0) {
        errors.push({
          field: "available_tools",
          message: `Unknown tool: ${bad.map(String).join(", ")}.`,
        });
      } else {
        // Deduplicated and ordered by the canonical list, so two sellers who
        // ticked the same boxes in a different order store the same row and a
        // later diff of the two is about the tools rather than the clicks.
        const set = new Set(raw as string[]);
        patch.availableTools = WORK_TOOLS.filter((t) => set.has(t));
      }
    }
  }

  if ("hourly_target_amount" in body) {
    const raw = body.hourly_target_amount;
    if (raw === null) {
      // The one field where an explicit null is a real value: it clears the
      // target back to "not set".
      patch.hourlyTargetAmount = null;
    } else if (typeof raw !== "number" || !Number.isFinite(raw)) {
      errors.push({
        field: "hourly_target_amount",
        message: "Hourly target must be a number, or null to clear it.",
      });
    } else if (raw < 0) {
      errors.push({
        field: "hourly_target_amount",
        message: "Hourly target cannot be negative.",
      });
    } else if (Math.round(raw * 100) !== raw * 100) {
      errors.push({
        field: "hourly_target_amount",
        message: "Hourly target can carry at most two decimal places.",
      });
    } else {
      patch.hourlyTargetAmount = raw;
    }
  }

  if ("hourly_target_currency" in body) {
    const raw = body.hourly_target_currency;
    if (
      typeof raw !== "string" ||
      !(SUPPORTED_CURRENCIES as readonly string[]).includes(raw)
    ) {
      errors.push({
        field: "hourly_target_currency",
        message:
          `Only ${SUPPORTED_CURRENCIES.join(", ")} is supported in this release.`,
      });
    } else {
      patch.hourlyTargetCurrency = raw as SupportedCurrency;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}

/** Apply a validated patch. Pure, so the merge rule is testable on its own. */
export function applyWorkPreferencesPatch(
  current: WorkPreferences,
  patch: WorkPreferencesPatch,
): WorkPreferences {
  return {
    defaultSessionMinutes: patch.defaultSessionMinutes ??
      current.defaultSessionMinutes,
    workContext: patch.workContext ?? current.workContext,
    availableTools: patch.availableTools ?? current.availableTools,
    // `??` would treat an explicit null as absent and make the target
    // impossible to clear, which is the bug AC3 is about. The key test is what
    // decides.
    hourlyTargetAmount: "hourlyTargetAmount" in patch
      ? patch.hourlyTargetAmount ?? null
      : current.hourlyTargetAmount,
    hourlyTargetCurrency: patch.hourlyTargetCurrency ??
      current.hourlyTargetCurrency,
    settingsVersion: SETTINGS_VERSION,
  };
}

/** A stored row as the API speaks it. */
export interface WorkPreferencesRow {
  default_session_minutes: number | null;
  work_context: string | null;
  available_tools: string[] | null;
  hourly_target_amount: number | string | null;
  hourly_target_currency: string | null;
  settings_version: number | null;
}

/**
 * A database row to the shape the planner reads.
 *
 * Tolerant in one direction only: an unreadable field falls back to its
 * default rather than throwing, because a settings row is not worth a 500 and
 * a seller with a corrupt row should still get a working default. A value that
 * is merely UNSET stays unset -- that is the hourly target, and it is the one
 * field where falling back would be wrong.
 */
export function rowToWorkPreferences(
  row: WorkPreferencesRow | null,
): WorkPreferences {
  const base = defaultWorkPreferences();
  if (!row) return base;
  const minutes = typeof row.default_session_minutes === "number" &&
      Number.isInteger(row.default_session_minutes) &&
      row.default_session_minutes >= MIN_SESSION_MINUTES &&
      row.default_session_minutes <= MAX_SESSION_MINUTES
    ? row.default_session_minutes
    : base.defaultSessionMinutes;
  const context =
    typeof row.work_context === "string" &&
      (WORK_CONTEXTS as readonly string[]).includes(row.work_context)
      ? row.work_context as WorkContext
      : base.workContext;
  const tools = Array.isArray(row.available_tools)
    ? WORK_TOOLS.filter((t) => row.available_tools!.includes(t))
    : base.availableTools;
  // PostgREST returns numeric columns as STRINGS. Reading this as a number
  // without the parse gives NaN, and NaN is neither null nor a target -- it
  // would render as "not set" on one screen and break arithmetic on another.
  const rawTarget = row.hourly_target_amount;
  let target: number | null = null;
  if (typeof rawTarget === "number" && Number.isFinite(rawTarget)) {
    target = rawTarget;
  } else if (typeof rawTarget === "string" && rawTarget.trim() !== "") {
    const parsed = Number(rawTarget);
    target = Number.isFinite(parsed) ? parsed : null;
  }
  const currency =
    typeof row.hourly_target_currency === "string" &&
      (SUPPORTED_CURRENCIES as readonly string[])
        .includes(row.hourly_target_currency)
      ? row.hourly_target_currency as SupportedCurrency
      : base.hourlyTargetCurrency;
  return {
    defaultSessionMinutes: minutes,
    workContext: context,
    availableTools: tools,
    hourlyTargetAmount: target,
    hourlyTargetCurrency: currency,
    settingsVersion: typeof row.settings_version === "number"
      ? row.settings_version
      : SETTINGS_VERSION,
  };
}

/** The JSON body every settings route returns. */
export function workPreferencesResponse(
  prefs: WorkPreferences,
): Record<string, unknown> {
  return {
    default_session_minutes: prefs.defaultSessionMinutes,
    work_context: prefs.workContext,
    available_tools: prefs.availableTools,
    hourly_target_amount: prefs.hourlyTargetAmount,
    hourly_target_currency: prefs.hourlyTargetCurrency,
    settings_version: prefs.settingsVersion,
    // The screen renders "not set" off this rather than off a falsy check,
    // because 0 is a legal target a seller can deliberately choose and a
    // falsy check would show it as unset.
    hourly_target_set: prefs.hourlyTargetAmount !== null,
    session_minute_presets: SESSION_MINUTE_PRESETS,
    min_session_minutes: MIN_SESSION_MINUTES,
    max_session_minutes: MAX_SESSION_MINUTES,
    work_contexts: WORK_CONTEXTS,
    work_tools: WORK_TOOLS,
  };
}
