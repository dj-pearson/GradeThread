// US-1535: the learnings loop, turned ON.
//
// All the few-shot machinery exists (assembly, golden-set eval gate,
// activation, grade-time injection) but shipped OFF — nothing assembled sets,
// so months of human corrections taught the grader nothing. This cron:
//   1. checks whether FRESH corrections/claim signals arrived since the last
//      auto-assembled set (idempotent per correction window — same-day reruns
//      and empty windows no-op),
//   2. assembles a versioned candidate set (auto_YYYYMMDD[_category]) mining
//      reviews + approved-claim signals, deduped + token-capped (AC4),
//   3. auto-runs the golden-set eval on the candidate,
//   4. on PASS: activates automatically only when the
//      grading_exemplar_auto_activate system setting is true; otherwise
//      notifies every admin with a link to the one-click activate in
//      /admin/grading. On FAIL: the set parks as failed_eval with its per-tag
//      breakdown visible in the same admin surface.
//
// Mounted in main.ts as POST /api/jobs/exemplar-assembly, OUTSIDE the /api/*
// JWT groups, gated by X-Internal-Job-Secret (same pattern as the other
// crons; schedule it in Coolify alongside them — weekly is a good default).
// Optional ?category=<garment_category> assembles a CATEGORY-SCOPED set
// (AC3): schedule extra invocations per category, or trigger ad-hoc.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { getSetting } from "../lib/system-settings.ts";
import { notifyUser } from "../lib/notify.ts";
import {
  activateExemplarSet,
  assembleExemplarSet,
  evalExemplarSet,
} from "../lib/few-shot-exemplars.ts";

const ADMIN_EXEMPLARS_LINK = "/admin/grading";

/** In-app note to every admin/super-admin (best-effort, never throws). */
async function notifyAdmins(title: string, message: string): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("users")
      .select("id")
      .in("role", ["admin", "super_admin"]);
    await Promise.all(
      ((data ?? []) as Array<{ id: string }>).map((admin) =>
        notifyUser(admin.id, {
          type: "system",
          title,
          message,
          link: ADMIN_EXEMPLARS_LINK,
        })
      ),
    );
  } catch (err) {
    console.error(
      "[exemplar-assembly] admin notify failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function handleExemplarAssemblyCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("exemplar-assembly", 900);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const category = c.req.query("category")?.trim().toLowerCase() || null;
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const versionName = category ? `auto_${day}_${category}` : `auto_${day}`;

    // Idempotency 1: one candidate per (day, scope).
    const { data: existing } = await supabaseAdmin
      .from("grading_exemplar_sets")
      .select("id, status")
      .eq("version_name", versionName)
      .maybeSingle();
    if (existing) {
      return c.json({
        ok: true,
        skipped: true,
        reason: `set ${versionName} already assembled (${(existing as { status: string }).status})`,
      });
    }

    // Idempotency 2: skip empty correction windows — no fresh review
    // corrections or claim signals since the last auto-assembled set.
    const { data: lastAuto } = await supabaseAdmin
      .from("grading_exemplar_sets")
      .select("created_at")
      .like("version_name", "auto_%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const windowStart = (lastAuto as { created_at: string } | null)?.created_at ??
      new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [{ count: freshReviews }, { count: freshClaims }] = await Promise.all([
      supabaseAdmin
        .from("human_reviews")
        .select("grade_report_id", { count: "exact", head: true })
        .gte("reviewed_at", windowStart),
      supabaseAdmin
        .from("claim_accuracy_signals")
        .select("claim_id", { count: "exact", head: true })
        .eq("active", true)
        .gte("updated_at", windowStart),
    ]);
    if ((freshReviews ?? 0) === 0 && (freshClaims ?? 0) === 0) {
      return c.json({
        ok: true,
        skipped: true,
        reason: `no fresh corrections since ${windowStart}`,
      });
    }

    // Assemble the candidate (mining is windowed inside; dedupe + token cap
    // applied there too).
    const set = await assembleExemplarSet({
      versionName,
      garmentCategory: category,
      createdBy: "cron:exemplar-assembly",
      notes: "auto-assembled by the scheduled learnings loop (US-1535)",
    });
    if (set.exemplar_count === 0) {
      // Nothing teachable — drop the empty candidate so the list stays clean.
      await supabaseAdmin.from("grading_exemplar_sets").delete().eq("id", set.id);
      return c.json({ ok: true, skipped: true, reason: "no high-signal corrections in window" });
    }

    // Auto-run the golden-set eval gate.
    const evalResult = await evalExemplarSet(set.id, "cron:exemplar-assembly");

    if (!evalResult.passed) {
      // Parked: status/eval fields were recorded by evalExemplarSet; the
      // per-tag breakdown is visible in the admin exemplars list.
      await notifyAdmins(
        "Exemplar set failed the eval gate",
        `${versionName} (${set.exemplar_count} exemplars) scored MAE ${
          evalResult.mean_absolute_error.toFixed(2)
        } / agreement ${(evalResult.agreement_rate * 100).toFixed(0)}% — parked for review.`,
      );
      return c.json({ ok: true, assembled: versionName, evaluated: true, passed: false });
    }

    // Passed: auto-activate only behind the explicit setting; default is a
    // one-click activation left to a human.
    const autoActivate = await getSetting<boolean>(
      "grading_exemplar_auto_activate",
      false,
    );
    if (autoActivate) {
      const activation = await activateExemplarSet(set.id);
      await notifyAdmins(
        activation.ok
          ? "Exemplar set auto-activated"
          : "Exemplar set passed eval but auto-activation failed",
        activation.ok
          ? `${versionName} passed the eval gate (MAE ${
            evalResult.mean_absolute_error.toFixed(2)
          }) and is now live on grading.`
          : `${versionName}: ${(activation as { reason?: string }).reason ?? "unknown error"}`,
      );
      return c.json({
        ok: true,
        assembled: versionName,
        evaluated: true,
        passed: true,
        activated: activation.ok,
      });
    }

    await notifyAdmins(
      "Exemplar set ready to activate",
      `${versionName} (${set.exemplar_count} exemplars) passed the eval gate — MAE ${
        evalResult.mean_absolute_error.toFixed(2)
      }, agreement ${(evalResult.agreement_rate * 100).toFixed(0)}%. One-click activate in the admin grading page.`,
    );
    return c.json({
      ok: true,
      assembled: versionName,
      evaluated: true,
      passed: true,
      activated: false,
    });
  } catch (err) {
    console.error(
      "[exemplar-assembly] failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Exemplar assembly failed" }, 500);
  } finally {
    await lock.release();
  }
}
