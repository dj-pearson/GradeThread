// US-929: lifecycle email-journey engine — shared types, token rendering, the
// per-tick planner, and the goal/exit predicate.
//
// PURE module: no supabase / network / env imports, so it's safe to unit-test
// directly (see email-journey_test.ts) and cheap to import anywhere. The edge
// job (routes/jobs-journey-tick.ts) owns the DB + email side; this file owns the
// decisions: which step is due, when to next evaluate, whether the journey's
// goal is met, and how to render a step's copy from its template + tokens.

// ── Types ──

export type JourneyTrigger =
  | "signup"
  | "trial_ending"
  | "inactivity"
  | "first_grade"
  | "first_sale";

export const JOURNEY_TRIGGERS: JourneyTrigger[] = [
  "signup",
  "trial_ending",
  "inactivity",
  "first_grade",
  "first_sale",
];

/** Transactional (welcome — never capped, no opt-out) vs marketing (nurture /
 * win-back — consent + suppression + cap + one-click unsubscribe). */
export type JourneyEmailClass = "transactional" | "marketing";

export interface JourneyStepDef {
  /** 1-based ordinal — the metrics + send-ledger grain (email_journey_step_sends.step_order). */
  stepOrder: number;
  /** Days after enrolment that the step becomes due. */
  offsetDays: number;
  subject: string;
  /** Content fragment template (may carry {{tokens}}). */
  bodyHtml: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  /** Opt this step into the optional AI intro line ({{aiIntro}} token). */
  aiPersonalize: boolean;
  enabled: boolean;
}

/** User context for personalization tokens + the goal/exit predicate. */
export interface JourneyUserState {
  firstName?: string | null;
  trialEndsAt?: string | null;
  /** Deep-link base for the dashboard ({{dashboardUrl}}). */
  dashboardUrl?: string;
  /** Optional AI-personalized opening sentence ({{aiIntro}}); empty when off/failed. */
  aiIntro?: string | null;
  /** trial_ending GOAL: the user converted (paid subscription active). */
  converted?: boolean;
  /** inactivity GOAL: the user became active again since enrolling. */
  reactivated?: boolean;
}

// ── Goal / exit ──

export interface JourneyGoal {
  met: boolean;
  /** exit_reason recorded on the enrolment when met. */
  reason: string | null;
}

/**
 * Has this journey's goal been reached, so the series should STOP early? The
 * trial-nurture stops the moment the user converts (no more "your trial is
 * ending" mail after they've paid); the win-back stops once the user is active
 * again. Other journeys have no early goal — they simply run to completion.
 */
export function journeyGoalMet(
  trigger: JourneyTrigger,
  state: JourneyUserState,
): JourneyGoal {
  if (trigger === "trial_ending" && state.converted === true) {
    return { met: true, reason: "converted" };
  }
  if (trigger === "inactivity" && state.reactivated === true) {
    return { met: true, reason: "reactivated" };
  }
  return { met: false, reason: null };
}

export function isMarketingClass(emailClass: JourneyEmailClass): boolean {
  return emailClass === "marketing";
}

// ── Copy rendering ──

/** Minimal HTML-escape for interpolated token VALUES (not the templates). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
      ? "&lt;"
      : ch === ">"
      ? "&gt;"
      : ch === '"'
      ? "&quot;"
      : "&#39;");
}

const DEFAULT_DASHBOARD_URL = "https://gradethread.com/dashboard";

function tokenValues(state: JourneyUserState): Record<string, string> {
  const dashboardUrl = (state.dashboardUrl ?? DEFAULT_DASHBOARD_URL).replace(/\/+$/, "");
  return {
    firstName: escapeHtml((state.firstName ?? "there").toString().trim() || "there"),
    trialEndsAt: state.trialEndsAt
      ? new Date(state.trialEndsAt).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      })
      : "soon",
    // dashboardUrl feeds href attributes — keep it raw (it is our own URL, not
    // user input) so the link isn't HTML-entity-mangled.
    dashboardUrl,
    // aiIntro is pre-rendered HTML (a <p>…</p>) or empty — injected verbatim.
    aiIntro: state.aiIntro ?? "",
  };
}

/** Replace `{{token}}` placeholders. Unknown tokens collapse to empty string. */
export function applyJourneyTokens(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : "");
}

const BRAND_RED = "#E94560";

/** Inline-styled CTA button matching the transactional email layout's button. */
function ctaButton(text: string, url: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 24px auto;">
    <tr>
      <td style="background-color: ${BRAND_RED}; border-radius: 8px;">
        <a href="${url}" style="display: inline-block; padding: 14px 32px; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600;">
          ${text}
        </a>
      </td>
    </tr>
  </table>`;
}

export interface RenderedJourneyStep {
  subject: string;
  /** Inner content fragment — the caller wraps it with the branded email layout. */
  contentHtml: string;
}

/**
 * Render a step's subject + content fragment for a user. Applies {{tokens}} to
 * the subject + body and appends the CTA (when both label + url are present).
 * The returned `contentHtml` is the INNER fragment — the route wraps it with the
 * shared emailLayout (brand header/footer + CAN-SPAM postal + optional
 * unsubscribe), so journey mail looks identical to every other GradeThread email.
 */
export function renderJourneyStep(
  step: JourneyStepDef,
  state: JourneyUserState = {},
): RenderedJourneyStep {
  const values = tokenValues(state);
  const body = applyJourneyTokens(step.bodyHtml ?? "", values);
  const cta = step.ctaLabel && step.ctaUrl
    ? ctaButton(
      applyJourneyTokens(step.ctaLabel, values),
      applyJourneyTokens(step.ctaUrl, values),
    )
    : "";
  return {
    subject: applyJourneyTokens(step.subject ?? "", values),
    contentHtml: body + cta,
  };
}

// ── Per-tick planner ──

const DAY_MS = 24 * 60 * 60 * 1000;

export type JourneyTickStatus = "send" | "wait" | "complete";

export interface JourneyTickPlan {
  status: JourneyTickStatus;
  /** The step to send (status="send") or the next due step (status="wait"). */
  step: JourneyStepDef | null;
  /** When the next unsent step becomes due (ms epoch), or null when complete. */
  dueAtMs: number | null;
}

/**
 * Decide what to do for ONE enrolment this tick, given the set of step ordinals
 * already sent. Steps run strictly in `stepOrder`; each becomes due at
 * `enrolledAt + offsetDays`. Returns the FIRST unsent enabled step:
 *   • not yet due  → "wait" with dueAtMs (the engine self-gates next_step_at on it)
 *   • due now      → "send" that step
 *   • none left    → "complete"
 *
 * Pure: the caller handles the goal-exit (which short-circuits the whole journey)
 * BEFORE calling this. At most one email is planned per enrolment per tick, so a
 * catch-up after downtime trickles rather than floods.
 */
export function planJourneyTick(
  steps: JourneyStepDef[],
  enrolledAtMs: number,
  sentOrdinals: Set<number>,
  nowMs: number,
): JourneyTickPlan {
  const ordered = steps
    .filter((s) => s.enabled)
    .slice()
    .sort((a, b) => a.stepOrder - b.stepOrder);

  for (const step of ordered) {
    if (sentOrdinals.has(step.stepOrder)) continue;
    const dueAtMs = enrolledAtMs + Math.max(0, step.offsetDays) * DAY_MS;
    if (dueAtMs > nowMs) return { status: "wait", step, dueAtMs };
    return { status: "send", step, dueAtMs };
  }
  return { status: "complete", step: null, dueAtMs: null };
}
