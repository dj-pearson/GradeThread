// US-933: pure predicate core extracted from segments.ts (US-625).
//
// This module owns the SINGLE field/op/value rule model used across the
// platform — the segment audience engine compiles it to a PostgREST query
// (segments.ts) AND the drip trigger engine evaluates it in-memory against a
// loaded snapshot (drip-trigger.ts). Keeping the allowlist, validation, and
// operator semantics here means there is exactly ONE rule language, never a
// parallel one.
//
// PURE: no supabase / network / env imports, so it is safe to unit-test
// directly and cheap to import into the (pure) trigger evaluator.

export type SegmentMatch = "all" | "any";

export interface SegmentCondition {
  field: string;
  op: string;
  value: string | number | boolean | string[] | null;
}

export interface SegmentRules {
  match: SegmentMatch;
  conditions: SegmentCondition[];
}

export type FieldKind = "enum" | "bool" | "number" | "date" | "date_nullable";

export interface FieldDef {
  kind: FieldKind;
  /** Allowed enum values (enum kind only). */
  values?: string[];
}

// Allowlist of segmentable columns on public.users. Anything not here is
// rejected. Keep this conservative — it is the injection boundary for the DB
// query path.
export const SEGMENT_USER_FIELDS: Record<string, FieldDef> = {
  role: { kind: "enum", values: ["user", "reviewer", "admin", "super_admin"] },
  flipdesk_plan: { kind: "enum", values: ["free", "starter", "pro", "business"] },
  subscription_status: {
    kind: "enum",
    values: ["none", "trialing", "active", "past_due", "paused", "canceled"],
  },
  suspended: { kind: "bool" },
  verified_enabled: { kind: "bool" },
  flipdesk_onboarded: { kind: "bool" },
  grades_used_this_month: { kind: "number" },
  grade_credit_balance: { kind: "number" },
  ai_actions_used_this_month: { kind: "number" },
  created_at: { kind: "date" },
  onboarded_at: { kind: "date_nullable" },
  trial_ends_at: { kind: "date_nullable" },
};

export const OPS_BY_KIND: Record<FieldKind, string[]> = {
  enum: ["eq", "neq", "in"],
  bool: ["eq"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte"],
  date: ["before", "after", "within_days"],
  date_nullable: ["before", "after", "within_days", "is_null", "not_null"],
};

// A safe enum/string token — no PostgREST metacharacters (comma, paren, dot)
// that could break out of an or() filter string.
export const SAFE_TOKEN = /^[a-zA-Z0-9_-]{1,40}$/;

// Internal compiled form: a single PostgREST predicate.
export interface Triple {
  col: string;
  /** PostgREST operator token, or the sentinels "isnull" / "notnull". */
  op: string;
  /** Pre-formatted value string (unused for isnull/notnull). */
  val: string;
}

export class SegmentRuleError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new SegmentRuleError(msg);
}

/** Validate + normalize a raw rules blob. Throws SegmentRuleError on anything
 *  malformed so callers can return a 400. `fields` lets a caller (e.g. the drip
 *  trigger engine) validate against a different allowlist than the user table. */
export function validateRules(
  raw: unknown,
  fields: Record<string, FieldDef> = SEGMENT_USER_FIELDS,
): SegmentRules {
  assert(raw && typeof raw === "object", "rules must be an object");
  const r = raw as Record<string, unknown>;
  const match = r.match === "any" ? "any" : "all";
  assert(Array.isArray(r.conditions), "rules.conditions must be an array");
  assert((r.conditions as unknown[]).length <= 25, "too many conditions (max 25)");

  const conditions: SegmentCondition[] = (r.conditions as unknown[]).map((c, i) => {
    assert(c && typeof c === "object", `condition ${i} must be an object`);
    const cond = c as Record<string, unknown>;
    const field = String(cond.field ?? "");
    const op = String(cond.op ?? "");
    const def = fields[field];
    assert(def, `unknown field: ${field}`);
    assert(OPS_BY_KIND[def.kind].includes(op), `operator ${op} invalid for ${field}`);
    const value = cond.value as SegmentCondition["value"];
    // Validate value shape against op/kind by attempting compilation now.
    compileCondition({ field, op, value }, def);
    return { field, op, value };
  });

  return { match, conditions };
}

function fmtEnum(v: unknown): string {
  const s = String(v);
  assert(SAFE_TOKEN.test(s), `invalid enum value: ${s}`);
  return s;
}

/** Compile one validated condition to a PostgREST predicate. `nowMs` anchors
 *  the relative `within_days` window (defaults to the wall clock for the DB
 *  query path). */
export function compileCondition(
  cond: SegmentCondition,
  def: FieldDef,
  nowMs: number = Date.now(),
): Triple {
  const { field, op, value } = cond;

  switch (def.kind) {
    case "enum": {
      if (op === "in") {
        assert(Array.isArray(value) && value.length > 0, `${field}.in needs a non-empty array`);
        const tokens = (value as unknown[]).map((v) => {
          const t = fmtEnum(v);
          if (def.values) assert(def.values.includes(t), `${t} not allowed for ${field}`);
          return t;
        });
        return { col: field, op: "in", val: `(${tokens.join(",")})` };
      }
      const t = fmtEnum(value);
      if (def.values) assert(def.values.includes(t), `${t} not allowed for ${field}`);
      return { col: field, op: op === "neq" ? "neq" : "eq", val: t };
    }
    case "bool": {
      assert(typeof value === "boolean", `${field} needs a boolean`);
      return { col: field, op: "is", val: value ? "true" : "false" };
    }
    case "number": {
      const n = Number(value);
      assert(Number.isFinite(n), `${field} needs a number`);
      return { col: field, op, val: String(n) };
    }
    case "date":
    case "date_nullable": {
      if (op === "is_null") return { col: field, op: "isnull", val: "" };
      if (op === "not_null") return { col: field, op: "notnull", val: "" };
      if (op === "within_days") {
        const days = Number(value);
        assert(Number.isFinite(days) && days > 0 && days <= 3650, `${field} within_days needs 1-3650`);
        const since = new Date(nowMs - days * 86_400_000).toISOString();
        return { col: field, op: "gte", val: since };
      }
      // before / after take an ISO date string.
      const s = String(value);
      const parsed = new Date(s);
      assert(!Number.isNaN(parsed.getTime()), `${field} needs a valid date`);
      return { col: field, op: op === "before" ? "lt" : "gt", val: parsed.toISOString() };
    }
  }
}

export function compileAll(
  rules: SegmentRules,
  fields: Record<string, FieldDef> = SEGMENT_USER_FIELDS,
): Triple[] {
  return rules.conditions.map((c) => compileCondition(c, fields[c.field]!));
}

// ── In-memory evaluation (US-933) ──
//
// The mirror of compileCondition: instead of producing a PostgREST predicate,
// evaluate the SAME field/op/value model against a snapshot value already loaded
// into memory. Used by the drip trigger engine so its state predicates speak the
// identical rule language as the audience segment engine — no parallel grammar.
// `nowMs` is injected (never read from the wall clock) so the evaluator stays
// pure and deterministic.

/** Evaluate ONE condition against the snapshot's value for that field. */
export function evaluateSegmentCondition(
  cond: SegmentCondition,
  def: FieldDef,
  value: unknown,
  nowMs: number,
): boolean {
  const { op } = cond;
  switch (def.kind) {
    case "enum": {
      const actual = value == null ? null : String(value);
      if (op === "in") {
        const tokens = Array.isArray(cond.value) ? cond.value.map(String) : [];
        return actual != null && tokens.includes(actual);
      }
      const target = String(cond.value);
      return op === "neq" ? actual !== target : actual === target;
    }
    case "bool": {
      return Boolean(value) === Boolean(cond.value);
    }
    case "number": {
      const a = Number(value);
      const b = Number(cond.value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      switch (op) {
        case "eq":
          return a === b;
        case "neq":
          return a !== b;
        case "gt":
          return a > b;
        case "gte":
          return a >= b;
        case "lt":
          return a < b;
        case "lte":
          return a <= b;
        default:
          return false;
      }
    }
    case "date":
    case "date_nullable": {
      if (op === "is_null") return value == null;
      if (op === "not_null") return value != null;
      // A null/unparseable date never satisfies a before/after/within window —
      // this is how AC3 "handle nulls safely" falls out (e.g. no trial_ends_at).
      if (value == null) return false;
      const t = Date.parse(String(value));
      if (Number.isNaN(t)) return false;
      if (op === "within_days") {
        const days = Number(cond.value);
        if (!Number.isFinite(days)) return false;
        return t >= nowMs - days * 86_400_000;
      }
      const bound = Date.parse(String(cond.value));
      if (Number.isNaN(bound)) return false;
      return op === "before" ? t < bound : t > bound;
    }
  }
}

/**
 * Evaluate a full rule set against an in-memory snapshot (field name → value).
 * `match: "all"` ⇒ every condition must hold (AND); `"any"` ⇒ at least one (OR).
 * Empty conditions ⇒ true (matches everyone, mirroring the segment engine).
 * Throws SegmentRuleError on an unknown field so a malformed spec fails loudly
 * rather than silently evaluating to false.
 */
export function evaluateSegmentRules(
  rules: SegmentRules,
  fields: Record<string, FieldDef>,
  snapshot: Record<string, unknown>,
  nowMs: number,
): boolean {
  if (rules.conditions.length === 0) return true;
  const results = rules.conditions.map((c) => {
    const def = fields[c.field];
    if (!def) throw new SegmentRuleError(`unknown field: ${c.field}`);
    return evaluateSegmentCondition(c, def, snapshot[c.field], nowMs);
  });
  return rules.match === "any" ? results.some(Boolean) : results.every(Boolean);
}
