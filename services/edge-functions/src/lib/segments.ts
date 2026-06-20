// US-625: audience segment rule engine.
//
// Compiles a validated rule tree into a PostgREST query against public.users
// and exposes count/preview + a paginated user iterator for the campaign send
// engine (US-627) and announcement targeting (US-628).
//
// SECURITY: this is PLATFORM-scoped (every user is a candidate), so it
// deliberately does NOT tenant-scope. It is reachable only from admin-gated
// edge routes. The rule JSON is allowlist-validated here — only known columns,
// known operators, and sanitized values ever reach the query, so a crafted
// `rules` blob can't inject arbitrary PostgREST filters.
//
// The field/op/value model, allowlist, validation, and compilation live in the
// PURE `segment-predicates.ts` (US-933) so the drip trigger engine can evaluate
// the SAME rule language in-memory — this file is just the supabase query path.

import { supabaseAdmin } from "./supabase.ts";
import { compileAll, SegmentRuleError, validateRules } from "./segment-predicates.ts";
import type { SegmentRules } from "./segment-predicates.ts";

// Re-export the shared rule types/helpers so existing importers
// (admin-growth.ts, announcements.ts) keep their `from "./segments.ts"` path.
export { SegmentRuleError, validateRules };
export type {
  SegmentCondition,
  SegmentMatch,
  SegmentRules,
} from "./segment-predicates.ts";

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

/** Does a single user satisfy a segment's rules? Used by announcement
 *  targeting (US-628). Empty rules → everyone matches. */
export async function userMatchesSegment(
  userId: string,
  rules: SegmentRules,
): Promise<boolean> {
  if (rules.conditions.length === 0) return true;
  const q = applyTriples(
    supabaseAdmin
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("id", userId),
    rules,
  );
  const { count, error } = await q;
  if (error) throw new SegmentRuleError(error.message);
  return (count ?? 0) > 0;
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
