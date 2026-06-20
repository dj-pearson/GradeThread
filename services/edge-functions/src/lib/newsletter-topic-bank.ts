// US-917: Evergreen educational topic bank — PURE module.
//
// No supabase / env / network imports (mirrors newsletter-tuning.ts) so the
// selection + dedup logic, the refill prompt builders, and the candidate parser
// all unit-test directly (newsletter-topic-bank_test.ts) with no env dance. The
// DB side (load / mark-used / refill) lives in newsletter-topic-bank-job.ts.
//
// The bank is the source of the issue's "teach-something" angle. Each row is an
// EVERGREEN lesson keyed by a (pillar, angle) pair; unlike one-shot content_topics
// it is reused over time, rate-limited only by a dedup window. Selection:
//   1. drop angles used within the dedup window (bank last_used_at, a recently-sent
//      issue's topic, or a content_history_index email row),
//   2. weight the survivors by the self-tuning topic bias (newsletter-tuning.ts)
//      so established winners get more airtime while new angles still explore,
//   3. pick deterministically (FNV over the period seed) so a dry-run preview and
//      the real build agree.

import {
  type NewsletterTopic,
  selectWeightedKey,
  topicByPillarAngle,
} from "./newsletter-tuning.ts";

// ── Row + selection types ────────────────────────────────────────────────────

export interface EmailTopicBankRow {
  id: string;
  pillar: string;
  angle: string;
  label: string;
  summary: string;
  key_points: string[];
  product_focus: "gradethread" | "flipdesk" | "both";
  status: "active" | "retired";
  source: string;
  last_used_at: string | null;
  use_count: number;
}

/** The chosen angle in the shape the assembler pipeline consumes. */
export interface BankSelection {
  /** NewsletterTopic-compatible (id/pillar/angle/label) for the copywriter + tuning. */
  topic: NewsletterTopic;
  /** The bank row id, so the caller can mark it used + stamp it on the issue. */
  bankId: string;
  /** One-line lesson summary — fed to the copy prompt as grounding. */
  summary: string;
  /** Real-capability bullet hints — fed to the copy prompt to prevent invention. */
  keyPoints: string[];
}

/** What the dedup pass considers "recently covered". Computed impurely, applied here. */
export interface CoverageContext {
  /** Exclude rows whose last_used_at is >= this ISO instant. */
  cutoffIso: string;
  /** `pillar:angle` keys covered by recently-sent / in-flight issues. */
  coveredTopicKeys: Set<string>;
  /** Lowercased labels/titles seen recently in content_history_index. */
  coveredLabels: Set<string>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Stable evergreen identity for an angle. */
export function topicKey(pillar: string, angle: string): string {
  return `${pillar.trim().toLowerCase()}:${angle.trim().toLowerCase()}`;
}

function normLabel(s: string): string {
  return s.trim().toLowerCase();
}

const PRODUCT_FOCUSES = new Set(["gradethread", "flipdesk", "both"]);

/** Validate + coerce a DB row (defensive against schema drift / nulls). */
export function normalizeBankRow(raw: unknown): EmailTopicBankRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const pillar = String(r.pillar ?? "").trim();
  const angle = String(r.angle ?? "").trim();
  const label = String(r.label ?? "").trim();
  if (!id || !pillar || !angle || !label) return null;
  const focus = String(r.product_focus ?? "both").trim().toLowerCase();
  const status = String(r.status ?? "active").trim().toLowerCase();
  return {
    id,
    pillar,
    angle,
    label,
    summary: String(r.summary ?? "").trim(),
    key_points: Array.isArray(r.key_points)
      ? (r.key_points as unknown[]).map((k) => String(k).trim()).filter(Boolean)
      : [],
    product_focus: PRODUCT_FOCUSES.has(focus) ? (focus as EmailTopicBankRow["product_focus"]) : "both",
    status: status === "retired" ? "retired" : "active",
    source: String(r.source ?? "seed").trim() || "seed",
    last_used_at: typeof r.last_used_at === "string" ? r.last_used_at : null,
    use_count: Number.isFinite(Number(r.use_count)) ? Math.max(0, Math.floor(Number(r.use_count))) : 0,
  };
}

/** A bank row mapped onto the NewsletterTopic the rest of the pipeline expects. */
export function bankRowToTopic(row: EmailTopicBankRow): NewsletterTopic {
  // Prefer the static tuning-catalog id when the (pillar, angle) matches one, so
  // engagement keeps attributing to it; otherwise a stable derived key.
  const catalog = topicByPillarAngle(row.pillar, row.angle);
  return {
    id: catalog?.id ?? topicKey(row.pillar, row.angle),
    pillar: row.pillar,
    angle: row.angle,
    label: row.label,
  };
}

/** Keep only active rows that haven't been covered within the dedup window. Pure. */
export function filterAvailableTopics(
  rows: EmailTopicBankRow[],
  ctx: CoverageContext,
): EmailTopicBankRow[] {
  return rows.filter((row) => {
    if (row.status !== "active") return false;
    if (row.last_used_at && row.last_used_at >= ctx.cutoffIso) return false;
    if (ctx.coveredTopicKeys.has(topicKey(row.pillar, row.angle))) return false;
    if (ctx.coveredLabels.has(normLabel(row.label))) return false;
    return true;
  });
}

/**
 * Weight a candidate set by the self-tuning topic bias. A candidate whose
 * (pillar, angle) maps to a tuning-catalog id with a positive bias weight inherits
 * it; everything else gets an exploration baseline (the average positive bias, or 1
 * at cold start) so new angles still get airtime without being starved or favoured.
 * Returns `topicKey → weight`. Pure.
 */
export function computeBankWeights(
  candidates: EmailTopicBankRow[],
  biasTopicWeights: Record<string, number>,
): Record<string, number> {
  const positives = Object.values(biasTopicWeights).filter((w) => typeof w === "number" && w > 0);
  const baseline =
    positives.length > 0 ? Math.max(1, Math.round(positives.reduce((s, w) => s + w, 0) / positives.length)) : 1;
  const out: Record<string, number> = {};
  for (const row of candidates) {
    const catalog = topicByPillarAngle(row.pillar, row.angle);
    const biased = catalog ? biasTopicWeights[catalog.id] : undefined;
    out[topicKey(row.pillar, row.angle)] = typeof biased === "number" && biased > 0 ? biased : baseline;
  }
  return out;
}

/** Deterministically pick one candidate by weighted bias. Pure. */
export function pickBankTopic(
  candidates: EmailTopicBankRow[],
  biasTopicWeights: Record<string, number>,
  seed: string,
): EmailTopicBankRow | null {
  if (candidates.length === 0) return null;
  const weights = computeBankWeights(candidates, biasTopicWeights);
  const key = selectWeightedKey(weights, seed);
  if (!key) return null;
  return candidates.find((r) => topicKey(r.pillar, r.angle) === key) ?? null;
}

/**
 * Full pure selection: filter by dedup window, then weighted pick. When every
 * active angle is within the window (small bank / wide window) fall back to the
 * least-recently-used third so the issue is NEVER blocked on topic exhaustion.
 */
export function selectFromBank(
  rows: EmailTopicBankRow[],
  ctx: CoverageContext,
  biasTopicWeights: Record<string, number>,
  seed: string,
): BankSelection | null {
  const active = rows.filter((r) => r.status === "active");
  if (active.length === 0) return null;

  let pool = filterAvailableTopics(active, ctx);
  if (pool.length === 0) {
    // Everything covered — fall back to the oldest-used third (variety without failing).
    const byOldest = [...active].sort((a, b) => {
      const av = a.last_used_at ?? "";
      const bv = b.last_used_at ?? "";
      return av < bv ? -1 : av > bv ? 1 : a.id.localeCompare(b.id);
    });
    pool = byOldest.slice(0, Math.max(1, Math.ceil(byOldest.length / 3)));
  }

  const row = pickBankTopic(pool, biasTopicWeights, seed);
  if (!row) return null;
  return {
    topic: bankRowToTopic(row),
    bankId: row.id,
    summary: row.summary,
    keyPoints: row.key_points,
  };
}

// ── Refill (Haiku-generated evergreen angles) ────────────────────────────────

export const EMAIL_TOPIC_REFILL_PROMPT_VERSION = "email_topic_refill_v1";

/** The pillars the bank spans — guides refill toward balanced coverage. */
export const EMAIL_TOPIC_PILLARS = [
  "grading",
  "listing",
  "pricing",
  "reselling",
  "photography",
  "workflow",
  "platform",
  "market",
  "authenticity",
  "trust",
  "sustainability",
] as const;

export interface RefillCandidate {
  pillar: string;
  angle: string;
  label: string;
  summary: string;
  key_points: string[];
}

/** True when the active bank has dropped below the configured minimum. */
export function needsRefill(activeCount: number, min: number): boolean {
  return activeCount < Math.max(0, Math.floor(min));
}

export function buildRefillSystemPrompt(input: {
  brandVoice: string;
  valueProps: string;
  existingKeys: string[];
}): string {
  const voice = input.brandVoice.trim() ? `\n\nBrand voice:\n${input.brandVoice.trim()}` : "";
  const claims = input.valueProps.trim()
    ? `\n\nApproved capabilities you may reference (do NOT invent beyond these):\n${input.valueProps.trim()}`
    : "";
  const existing =
    input.existingKeys.length > 0
      ? `\n\nAngles already in the bank — do NOT repeat these (pillar:angle):\n${input.existingKeys.join(", ")}`
      : "";
  return (
    `You curate an EVERGREEN educational topic bank for GradeThread's weekly ` +
    `newsletter (gradethread.com), an AI-powered clothing condition grading platform ` +
    `with FlipDesk for the full reselling lifecycle. Each topic is a reusable lesson ` +
    `that teaches resellers/sellers something concrete about grading, accurate ` +
    `listings, condition standards, pricing/comps, photography, reseller workflow, or ` +
    `trust/authenticity. Topics must be TIMELESS (no dated news, no seasonal hooks), ` +
    `genuinely useful, and grounded ONLY in real platform capabilities — never invent ` +
    `features, statistics, prices, or customer counts.${voice}${claims}${existing}\n\n` +
    `Respond with ONLY a JSON object (no markdown fences):\n` +
    `{"candidates":[{"pillar":string,"angle":string,"label":string,"summary":string,"key_points":[string]}]}\n` +
    `pillar is a short lowercase slug; angle is a short lowercase kebab-case slug ` +
    `unique within its pillar; label is a working title; summary is one sentence; ` +
    `key_points are 1-3 short factual hints grounded in real capabilities.`
  );
}

export function buildRefillUserPrompt(count: number): string {
  const n = Math.min(Math.max(1, Math.floor(count)), 25);
  return (
    `Propose ${n} NEW evergreen newsletter topics spanning the pillars ` +
    `(${EMAIL_TOPIC_PILLARS.join(", ")}). Favour gaps not already covered. Keep every ` +
    `angle email-appropriate, skimmable, and timeless.`
  );
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function normalizeRefillCandidate(raw: unknown): RefillCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const pillar = slugify(String(p.pillar ?? ""));
  const angle = slugify(String(p.angle ?? ""));
  const label = String(p.label ?? "").trim();
  if (!pillar || !angle || !label) return null;
  return {
    pillar,
    angle,
    label: label.slice(0, 160),
    summary: String(p.summary ?? "").trim().slice(0, 400),
    key_points: Array.isArray(p.key_points)
      ? (p.key_points as unknown[]).map((k) => String(k).trim()).filter(Boolean).slice(0, 3)
      : [],
  };
}

function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

/** Parse the model's JSON into clean candidates. Throws on unparseable output. Pure. */
export function parseRefillCandidates(raw: string): RefillCandidate[] {
  let parsed: { candidates?: unknown[] };
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new Error("topic-refill JSON parse failed");
  }
  return (parsed.candidates ?? [])
    .map(normalizeRefillCandidate)
    .filter((c): c is RefillCandidate => c !== null);
}
