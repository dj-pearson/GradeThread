import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";

// US-1855: the WRITE half of the public Showcase / "Finds" feed.
//
// Two things a signed-in person can do:
//   • consent (or withdraw consent) for one of their OWN finds to appear
//   • react to (upvote) a find that is already public
//
// Mounted behind authMiddleware in main.ts, so c.var.userId is the caller.
// US-268: the consent write is scoped `.eq("user_id", userId)` — the submission
// id arrives in the request body, so it is never trusted on its own. The
// reaction write stores the caller's own id and can only target a find the
// PUBLIC view already exposes, so it can neither name another tenant's row nor
// be used to probe whether a private certificate exists.
//
// Public READS live in content-public.ts (GET /finds.json).

type ShowcaseEnv = { Variables: { userId: string } };

export const showcaseRoutes = new Hono<ShowcaseEnv>();

/** Matches the CHECK in migration 00543 ($1,000,000). */
const MAX_VALUE_CENTS = 100_000_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConsentBody {
  submission_id?: unknown;
  opt_in?: unknown;
  value_cents?: unknown;
}

// ── PUT /consent ──────────────────────────────────────────────────
// Turn the public Showcase on or off for ONE of the caller's own finds.
showcaseRoutes.put("/consent", async (c) => {
  const userId = c.get("userId");

  let body: ConsentBody;
  try {
    body = (await c.req.json()) as ConsentBody;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const submissionId = typeof body.submission_id === "string"
    ? body.submission_id.trim()
    : "";
  if (!UUID_RE.test(submissionId)) {
    return c.json({ error: "A valid submission id is required." }, 400);
  }
  const optIn = body.opt_in === true;

  // Seller-STATED value. Only accepted alongside consent — withdrawing clears
  // it, so a hidden find never keeps a price we would have to remember not to
  // publish. `null` is an explicit "no value shown".
  let valueCents: number | null = null;
  if (optIn && body.value_cents !== undefined && body.value_cents !== null) {
    const raw = Number(body.value_cents);
    if (!Number.isFinite(raw) || raw < 0 || raw > MAX_VALUE_CENTS) {
      return c.json({ error: "Enter a value between $0 and $1,000,000." }, 400);
    }
    valueCents = Math.round(raw);
  }

  // US-268: `.eq("user_id", userId)` is what makes the body-supplied id safe.
  // A submission belonging to someone else matches zero rows and returns 404 —
  // indistinguishable from a submission that does not exist, so this cannot be
  // used to test whether an id is real.
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .update({
      showcase_opt_in: optIn,
      showcase_opted_in_at: optIn ? new Date().toISOString() : null,
      showcase_value_cents: optIn ? valueCents : null,
    })
    .eq("id", submissionId)
    .eq("user_id", userId)
    .select("id, showcase_opt_in, showcase_opted_in_at, showcase_value_cents")
    .maybeSingle();

  if (error) {
    return failSafe(c, 500, "Couldn't update your Showcase setting.", error, "showcase.consent");
  }
  if (!data) return c.json({ error: "Not found." }, 404);

  const row = data as {
    showcase_opt_in: boolean;
    showcase_opted_in_at: string | null;
    showcase_value_cents: number | null;
  };
  return c.json({
    showcase: {
      opt_in: row.showcase_opt_in,
      opted_in_at: row.showcase_opted_in_at,
      value_cents: row.showcase_value_cents,
    },
  });
});

/** Count the reactions on one find. Aggregate only — never the reactor list. */
async function reactionCount(gradeReportId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("showcase_reactions")
    .select("id", { count: "exact", head: true })
    .eq("grade_report_id", gradeReportId);
  return count ?? 0;
}

// ── POST /reactions/:id ───────────────────────────────────────────
// Toggle the caller's upvote on a PUBLIC find. `:id` is a grade_report id.
showcaseRoutes.post("/reactions/:id", async (c) => {
  const userId = c.get("userId");
  const gradeReportId = c.req.param("id");
  if (!UUID_RE.test(gradeReportId)) return c.json({ error: "Not found." }, 404);

  // The find must be publicly showcased. Checked against the VIEW, which is
  // where consent + certificate visibility already live, so this handler never
  // re-implements either rule — and a report that is private, withheld or not
  // opted in is simply absent, which is the same 404 as a bad id.
  const { data: find, error: findErr } = await supabaseAdmin
    .from("public_showcase_finds")
    .select("grade_report_id")
    .eq("grade_report_id", gradeReportId)
    .maybeSingle();
  if (findErr) {
    return failSafe(c, 500, "Couldn't record your reaction.", findErr, "showcase.react-lookup");
  }
  if (!find) return c.json({ error: "Not found." }, 404);

  // Toggle: an existing reaction by THIS caller is removed, otherwise added.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("showcase_reactions")
    .select("id")
    .eq("grade_report_id", gradeReportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingErr) {
    return failSafe(c, 500, "Couldn't record your reaction.", existingErr, "showcase.react-read");
  }

  if (existing) {
    const { error: delErr } = await supabaseAdmin
      .from("showcase_reactions")
      .delete()
      .eq("id", (existing as { id: string }).id)
      .eq("user_id", userId);
    if (delErr) {
      return failSafe(c, 500, "Couldn't remove your reaction.", delErr, "showcase.react-delete");
    }
    return c.json({ reacted: false, reactions: await reactionCount(gradeReportId) });
  }

  const { error: insErr } = await supabaseAdmin
    .from("showcase_reactions")
    .insert({ grade_report_id: gradeReportId, user_id: userId });
  // 23505 = the unique index fired because a concurrent request already added
  // it. The end state the caller asked for is the one they now have, so this is
  // success, not an error.
  if (insErr && (insErr as { code?: string }).code !== "23505") {
    return failSafe(c, 500, "Couldn't record your reaction.", insErr, "showcase.react-insert");
  }
  return c.json({ reacted: true, reactions: await reactionCount(gradeReportId) });
});

// ── GET /reactions?ids=a,b,c ──────────────────────────────────────
// Which of these finds the CALLER has already reacted to, so the feed can render
// their own state. Owner-scoped (US-268): it reads only rows with the caller's
// user_id, so it can never report anyone else's reactions.
showcaseRoutes.get("/reactions", async (c) => {
  const userId = c.get("userId");
  const ids = (c.req.query("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s))
    .slice(0, 100);
  if (ids.length === 0) return c.json({ reacted: [] });

  const { data, error } = await supabaseAdmin
    .from("showcase_reactions")
    .select("grade_report_id")
    .eq("user_id", userId)
    .in("grade_report_id", ids);
  if (error) {
    return failSafe(c, 500, "Couldn't load your reactions.", error, "showcase.my-reactions");
  }
  return c.json({
    reacted: (data ?? []).map((r) => (r as { grade_report_id: string }).grade_report_id),
  });
});
