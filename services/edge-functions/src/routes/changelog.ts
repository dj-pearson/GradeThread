import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { captureException, readCtxVar } from "../lib/observability.ts";
import {
  type ChangelogRow,
  isChangelogAudience,
  toPublicEntry,
} from "../lib/changelog.ts";
import { CHANGELOG_COLS } from "../lib/changelog-job.ts";

// US-916: PUBLIC "What's New" changelog feed. Anonymous/unauthenticated — powers
// a public /changelog page AND an in-app "What's New" panel.
//
// Mounted at /api/changelog (OUTSIDE the /api/admin/* middleware). The
// service-role client bypasses RLS, so EVERY query MUST be hard-filtered to
// status='published' — that filter is the sole gate keeping unpublished drafts
// from leaking. Errors return a generic body (no DB internals to the public).

export const changelogPublicRoutes = new Hono();

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function publicError(c: Context, err: unknown, label: string): Response {
  let path = c.req.path;
  try {
    path = new URL(c.req.url).pathname;
  } catch { /* keep c.req.path */ }
  captureException(err, {
    route: `${c.req.method} ${path}`,
    method: c.req.method,
    url: `${path} (${label})`,
    correlationId: readCtxVar(c, "correlationId"),
  });
  console.error("changelog-public", label, err instanceof Error ? err.message : String(err));
  return c.json({ error: "Internal error" }, 500);
}

// ── GET / ─────────────────────────────────────────────────
// Published entries, newest first. Cursor pagination by published_at. An optional
// ?audience= narrows to a single audience (the in-app panel passes the viewer's
// audience so a grading-only user never sees FlipDesk-only news); 'all' entries
// are always included.
changelogPublicRoutes.get("/", async (c) => {
  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const cursor = c.req.query("cursor");
  const audience = c.req.query("audience");

  let q = supabaseAdmin
    .from("changelog_entries")
    .select(CHANGELOG_COLS)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (cursor) q = q.lt("published_at", cursor);
  if (audience && isChangelogAudience(audience) && audience !== "all") {
    q = q.in("audience", ["all", audience]);
  }

  const { data, error } = await q;
  if (error) return publicError(c, error, "query");

  const rows = (data ?? []) as unknown as ChangelogRow[];
  const nextCursor = rows.length === limit
    ? rows[rows.length - 1]?.published_at ?? null
    : null;
  return c.json({
    entries: rows.map(toPublicEntry),
    next_cursor: nextCursor,
  });
});
