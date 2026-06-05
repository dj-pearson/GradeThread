// US-570: audience segment rule engine.
//
// Compiles a validated rule tree into a PostgREST query against public.users
// and exposes count/preview + a paginated user iterator for the campaign send
// engine (US-572) and announcement targeting (US-573).
//
// SECURITY: this is PLATFORM-scoped (every user is a candidate), so it
// deliberately does NOT tenant-scope. It is reachable only from admin-gated
// edge routes. The rule JSON is allowlist-validated here — only known columns,
// known operators, and sanitized values ever reach the query, so a crafted
// `rules` blob can't inject arbitrary PostgREST filters.

import { supabaseAdmin } from "./supabase.ts";

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

type FieldKind = "enum" | "bool" | "number" | "date" | "date_nullable";

interface FieldDef {
  kind: FieldKind;
  /** Allowed enum values (enum kind only). */
  values?: string[];
}

// Allowlist of segmentable columns on public.users. Anything not here is
// rejected. Keep this conservative — it is the injection boundary.
const FIELDS: Record<string, FieldDef> = {
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

const OPS_BY_KIND: Record<FieldKind, string[]> = {
  enum: ["eq", "neq", "in"],
  bool: ["eq"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte"],
  date: ["before", "after", "within_days"],
  date_nullable: ["before", "after", "within_days", "is_null", "not_null"],
};

// A safe enum/string token — no PostgREST metacharacters (comma, paren, dot)
// that could break out of an or() filter string.
const SAFE_TOKEN = /^[a-zA-Z0-9_-]{1,40}$/;

// Internal compiled form: a single PostgREST predicate.
interface Triple {
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
 *  malformed so callers can return a 400. */
export function validateRules(raw: unknown): SegmentRules {
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
    const def = FIELDS[field];
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

function compileCondition(cond: SegmentCondition, def: FieldDef): Triple {
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
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
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

function compileAll(rules: SegmentRules): Triple[] {
  return rules.conditions.map((c) => compileCondition(c, FIELDS[c.field]));
}

// deno-lint-ignore no-explicit-any
function applyTriples(query: any, rules: SegmentRules): any {
  const triples = compileAll(rules);
  if (triples.length === 0) return query;

  if (rules.match === "any") {
    const parts = triples.map((t) => {
      if (t.op === "isnull") return `${t.col}.is.null`;
      if (t.op === "notnull") return `${t.col}.not.is.null`;
      return `${t.col}.${t.op}.${t.val}`;
    });
    return query.or(parts.join(","));
  }

  // "all" — chain a filter per condition.
  let q = query;
  for (const t of triples) {
    if (t.op === "isnull") q = q.is(t.col, null);
    else if (t.op === "notnull") q = q.not(t.col, "is", null);
    else q = q.filter(t.col, t.op, t.val);
  }
  return q;
}

/** Live count + a small email sample for the preview UI. */
export async function previewSegment(
  rules: SegmentRules,
): Promise<{ count: number; sampleEmails: string[] }> {
  const countQuery = applyTriples(
    supabaseAdmin.from("users").select("id", { count: "exact", head: true }),
    rules,
  );
  const { count, error } = await countQuery;
  if (error) throw new SegmentRuleError(error.message);

  const sampleQuery = applyTriples(
    supabaseAdmin.from("users").select("email").limit(5),
    rules,
  );
  const { data: sample } = await sampleQuery;
  const sampleEmails = ((sample ?? []) as Array<{ email: string }>).map((r) => r.email);

  return { count: count ?? 0, sampleEmails };
}

/** Stream every matching user in pages — used by the campaign send engine.
 *  Returns id + email + notification_preferences for opt-out checks. */
export async function* iterateSegmentUsers(
  rules: SegmentRules,
  pageSize = 500,
): AsyncGenerator<
  Array<{ id: string; email: string; notification_preferences: Record<string, unknown> | null }>
> {
  let from = 0;
  // Order by id for a stable keyset-ish pagination across pages.
  for (;;) {
    const q = applyTriples(
      supabaseAdmin
        .from("users")
        .select("id, email, notification_preferences")
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1),
      rules,
    );
    const { data, error } = await q;
    if (error) throw new SegmentRuleError(error.message);
    const rows = (data ?? []) as Array<{
      id: string;
      email: string;
      notification_preferences: Record<string, unknown> | null;
    }>;
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < pageSize) return;
    from += pageSize;
  }
}
