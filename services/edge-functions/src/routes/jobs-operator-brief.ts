// US-1592 / AGENTIC-OS Phase 0 (Module N): the Daily Operator Brief cron.
//
// POST /api/jobs/operator-brief (X-Internal-Job-Secret) — mounted on the shared
// job rails. Gathers the last 24h of agent activity, assembles ONE brief
// (lib/agent-brief.ts, pure), renders it via the existing email machinery,
// emails the admins (suppression- + pref-aware), and persists the latest brief
// to system_settings so Mission Control can show it. Degrades gracefully with
// zero agents (still sends, states the fleet is empty).

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { deliverEmail } from "../lib/email.ts";
import { renderEmailDocument } from "../lib/email-render.ts";
import {
  assembleBrief,
  type BriefEvent,
  type BriefProposal,
  type BriefRun,
  briefSubject,
  briefToEmailDocument,
} from "../lib/agent-brief.ts";

const LATEST_BRIEF_SETTING_KEY = "agents.latest_brief";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleOperatorBriefCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("operator-brief", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const nowMs = Date.now();
    const sinceIso = new Date(nowMs - DAY_MS).toISOString();
    const appUrl = Deno.env.get("APP_URL") ?? Deno.env.get("SITE_URL") ?? "https://gradethread.com";
    const missionControlUrl = `${appUrl}/admin/agents`;

    // Gather the day's rows.
    const [agentsRes, runsRes, propsRes, eventsRes] = await Promise.all([
      supabaseAdmin.from("agents").select("id, key, name"),
      supabaseAdmin.from("agent_runs").select("agent_id, status, cost_usd").gte("started_at", sinceIso),
      supabaseAdmin.from("agent_proposals").select("id, agent_id, title, expires_at").eq("status", "pending"),
      supabaseAdmin
        .from("ops_events")
        .select("type, title")
        .in("severity", ["warning", "critical"])
        .like("type", "agent.%")
        .gte("created_at", sinceIso),
    ]);

    const agents = (agentsRes.data ?? []) as Array<{ id: string; key: string; name: string }>;
    const keyById = new Map(agents.map((a) => [a.id, a.key]));

    const runs24h: BriefRun[] = ((runsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      agent_key: keyById.get(String(r.agent_id)) ?? null,
      status: String(r.status),
      cost_usd: typeof r.cost_usd === "number" ? r.cost_usd : Number(r.cost_usd) || 0,
    }));
    const pendingProposals: BriefProposal[] = ((propsRes.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: String(p.id),
      agent_key: keyById.get(String(p.agent_id)) ?? null,
      title: String(p.title),
      expires_at: (p.expires_at as string | null) ?? null,
    }));
    const warningEvents24h: BriefEvent[] = ((eventsRes.data ?? []) as Array<Record<string, unknown>>).map((e) => ({
      type: String(e.type),
      title: (e.title as string | null) ?? null,
    }));

    const model = assembleBrief({
      now: nowMs,
      missionControlUrl,
      agents: agents.map((a) => ({ key: a.key, name: a.name })),
      runs24h,
      pendingProposals,
      warningEvents24h,
    });

    const dateLabel = new Date(nowMs).toISOString().slice(0, 10);
    const doc = briefToEmailDocument(model, dateLabel);
    const rendered = renderEmailDocument(doc, { siteUrl: appUrl });

    // Persist the latest brief for Mission Control (system_settings, no migration).
    await supabaseAdmin
      .from("system_settings")
      .upsert(
        { key: LATEST_BRIEF_SETTING_KEY, value: { model, generated_at: dateLabel, generated_at_ms: nowMs } },
        { onConflict: "key" },
      );

    // Email the admins — suppression-safe (deliverEmail) + honor an explicit
    // per-admin opt-out (notification_preferences.operator_brief === false).
    const { data: adminRows } = await supabaseAdmin
      .from("users")
      .select("email, notification_preferences")
      .in("role", ["admin", "super_admin"]);
    let sent = 0;
    for (const a of (adminRows ?? []) as Array<{ email: string | null; notification_preferences: unknown }>) {
      if (!a.email) continue;
      const prefs = a.notification_preferences as { operator_brief?: boolean } | null;
      if (prefs?.operator_brief === false) continue;
      const ok = await deliverEmail({
        to: a.email,
        subject: briefSubject(model, dateLabel),
        html: rendered.html,
        category: "operator-brief",
      });
      if (ok) sent += 1;
    }

    return c.json({
      ok: true,
      headline: model.headline,
      pending: model.pending.length,
      anomalies: model.anomalies.length,
      total_runs: model.totalRuns,
      emails_sent: sent,
    });
  } catch (err) {
    console.error("[operator-brief] failed:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Operator brief failed" }, 500);
  } finally {
    await lock.release();
  }
}
