import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { isCertificateWithheld } from "../lib/certificate-visibility.ts";
import { captureException, readCtxVar } from "../lib/observability.ts";

// US-867: buyer trust-guarantee claim intake (PUBLIC, unauthenticated).
//
// Buyers of graded items are typically NOT GradeThread account holders, so the
// claim is filed without a session. Mounted at /api/guarantee (rate-limited +
// fail-closed in main.ts). The service-role client bypasses RLS, so EVERY write
// here MUST resolve ownership server-side from the public certificate_id — the
// request body never dictates the tenant or the internal grade_report_id.
//
// Like content-public.ts, a 500 body must never leak DB internals to anonymous
// callers — log server-side, return a generic error.

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
  console.error(
    `guarantee-public ${label}:`,
    err instanceof Error ? err.message : String(err),
  );
  return c.json({ error: "Internal error" }, 500);
}

export const guaranteePublicRoutes = new Hono();

// Input caps — keep the anonymous intake bounded so it can't be abused to dump
// large blobs into the table.
const MAX_REASON = 4000;
const MAX_NAME = 200;
const MAX_EMAIL = 320; // RFC 5321 max
const MAX_MARKETPLACE = 80;
const MAX_ORDER_REF = 200;
const MAX_EVIDENCE_URLS = 10;
const MAX_URL_LEN = 2000;
const MAX_CLAIMED_ISSUES = 25;
const MAX_ISSUE_FIELD = 500;

// Conservative email shape check (defense-in-depth; not a deliverability check).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SEVERITIES = new Set(["minor", "moderate", "major"]);

function asString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

// Normalize the optional structured issues into a clean, bounded array.
function normalizeIssues(raw: unknown): Array<{
  defect: string;
  severity: string;
  location: string;
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ defect: string; severity: string; location: string }> = [];
  for (const item of raw.slice(0, MAX_CLAIMED_ISSUES)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const defect = asString(rec.defect, MAX_ISSUE_FIELD);
    if (!defect) continue;
    const sevRaw = typeof rec.severity === "string" ? rec.severity.toLowerCase() : "";
    const severity = SEVERITIES.has(sevRaw) ? sevRaw : "moderate";
    const location = asString(rec.location, MAX_ISSUE_FIELD) ?? "";
    out.push({ defect, severity, location });
  }
  return out;
}

// Normalize evidence URLs: keep only well-formed http(s) links, bounded.
function normalizeEvidenceUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw.slice(0, MAX_EVIDENCE_URLS)) {
    if (typeof item !== "string") continue;
    const t = item.trim().slice(0, MAX_URL_LEN);
    if (!t) continue;
    try {
      const u = new URL(t);
      if (u.protocol === "http:" || u.protocol === "https:") out.push(t);
    } catch { /* skip malformed URL */ }
  }
  return out;
}

// ── POST /claims ──────────────────────────────────────────────────
// Body: { certificate_id, claimant_email, reason, claimant_name?, marketplace?,
//         order_reference?, claimed_issues?, evidence_urls? }
guaranteePublicRoutes.post("/claims", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const certificateId = asString(body.certificate_id, 100);
  if (!certificateId) {
    return c.json({ error: "certificate_id is required" }, 400);
  }
  const claimantEmail = asString(body.claimant_email, MAX_EMAIL);
  if (!claimantEmail || !EMAIL_RE.test(claimantEmail)) {
    return c.json({ error: "A valid contact email is required" }, 400);
  }
  const reason = asString(body.reason, MAX_REASON);
  if (!reason || reason.length < 20) {
    return c.json(
      { error: "Please describe how the item differs from its grade (at least 20 characters)" },
      400,
    );
  }
  const claimantName = asString(body.claimant_name, MAX_NAME);
  const marketplace = asString(body.marketplace, MAX_MARKETPLACE);
  const orderReference = asString(body.order_reference, MAX_ORDER_REF);
  const claimedIssues = normalizeIssues(body.claimed_issues);
  const evidenceUrls = normalizeEvidenceUrls(body.evidence_urls);

  // Resolve the certified (public) report from the certificate_id. Same RLS-safe
  // gate as content-public: look up BY certificate_id, never by internal id, and
  // require a non-null certificate_id so a private report is unreachable.
  let report:
    | { id: string; submission_id: string }
    | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from("grade_reports")
      .select("id, submission_id, certificate_id")
      .eq("certificate_id", certificateId)
      .not("certificate_id", "is", null)
      .maybeSingle();
    if (error) return publicError(c, error, "lookup");
    report = (data as { id: string; submission_id: string } | null) ?? null;
  } catch (err) {
    return publicError(c, err, "lookup");
  }
  if (!report) {
    return c.json({ error: "Certificate not found" }, 404);
  }

  // Resolve the owning tenant + withholding gate from the parent submission. A
  // flagged/withheld certificate isn't publicly trustworthy, so it can't anchor
  // a claim — 404 exactly like the public cert endpoint (US-484).
  let sellerUserId: string | null = null;
  try {
    const { data: sub, error } = await supabaseAdmin
      .from("submissions")
      .select("user_id, flagged, moderation_status")
      .eq("id", report.submission_id)
      .maybeSingle();
    if (error) return publicError(c, error, "submission");
    const s = sub as
      | { user_id: string; flagged?: boolean | null; moderation_status?: string | null }
      | null;
    if (!s || isCertificateWithheld(s)) {
      return c.json({ error: "Certificate not found" }, 404);
    }
    sellerUserId = s.user_id;
  } catch (err) {
    return publicError(c, err, "submission");
  }

  try {
    const { data: inserted, error } = await supabaseAdmin
      .from("guarantee_claims")
      .insert({
        certificate_id: certificateId,
        grade_report_id: report.id,
        seller_user_id: sellerUserId,
        claimant_email: claimantEmail,
        claimant_name: claimantName,
        marketplace,
        order_reference: orderReference,
        reason,
        claimed_issues: claimedIssues,
        evidence_urls: evidenceUrls,
        status: "submitted",
      })
      .select("id, status")
      .single();
    if (error) return publicError(c, error, "insert");

    const row = inserted as { id: string; status: string };
    return c.json({ ok: true, claim_id: row.id, status: row.status }, 201);
  } catch (err) {
    return publicError(c, err, "insert");
  }
});
