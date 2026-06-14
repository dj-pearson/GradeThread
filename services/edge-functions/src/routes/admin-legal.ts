import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { loadLegalVersionState } from "../lib/legal-versions.ts";

// US-904: Legal/ToS version manager.
//
// Mounted at /api/admin/compliance/legal — inherits authMiddleware +
// adminAuthMiddleware (admin/super_admin + AAL2 MFA) from the /api/admin/* group
// in main.ts. These are admin-gated, intentionally CROSS-TENANT reads (coverage
// spans every user); the admin+MFA gate is the authorization boundary.
//
//   GET  /  → published versions + current/required state + acceptance coverage
//   POST /  → publish a new version (super_admin + fresh MFA step-up; audited)
//
// Publishing a version with requires_reacceptance flips users to "must
// re-accept": the edge legal routes (loadLegalVersionState) immediately read the
// new bar and the in-app gate blocks until the user re-accepts.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminLegalRoutes = new Hono<AdminEnv>();

const VALID_KINDS = new Set(["tos", "privacy"]);
// YYYY-MM-DD — versions are by convention the document's effective date.
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

interface LegalDocumentRow {
  id: string;
  kind: "tos" | "privacy";
  version: string;
  effective_date: string;
  url: string | null;
  body: string | null;
  requires_reacceptance: boolean;
  published_at: string;
  published_by: string | null;
  created_at: string;
}

// Count of users whose recorded acceptance matches BOTH current versions, over
// the active-user denominator (anonymized/erased accounts excluded).
async function acceptanceCoverage(
  currentTos: string,
  currentPrivacy: string,
): Promise<{ total_active: number; on_current: number; coverage_pct: number }> {
  // "Active" = real accounts; anonymized/erased accounts are excluded.
  const ANON = "%@anonymized.invalid";

  const totalRes = await supabaseAdmin
    .from("users")
    .select("id", { count: "exact", head: true })
    .not("email", "ilike", ANON);
  const total = totalRes.count ?? 0;

  const onCurrentRes = await supabaseAdmin
    .from("users")
    .select("id", { count: "exact", head: true })
    .not("email", "ilike", ANON)
    .eq("tos_accepted_version", currentTos)
    .eq("privacy_accepted_version", currentPrivacy);
  const onCurrent = onCurrentRes.count ?? 0;

  const pct = total > 0 ? Math.round((onCurrent / total) * 1000) / 10 : 0;
  return { total_active: total, on_current: onCurrent, coverage_pct: pct };
}

// ── GET / — published versions, current/required state, coverage ─────────────
adminLegalRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("legal_documents")
    .select(
      "id, kind, version, effective_date, url, body, requires_reacceptance, published_at, published_by, created_at",
    )
    .order("effective_date", { ascending: false })
    .order("published_at", { ascending: false });
  if (error) {
    console.error("[admin-legal] list failed:", error.message);
    return c.json({ error: "Could not load legal documents" }, 500);
  }

  const documents = (data ?? []) as unknown as LegalDocumentRow[];

  // Resolve publisher emails without N+1 reads.
  const publisherIds = [
    ...new Set(documents.map((d) => d.published_by).filter((x): x is string => !!x)),
  ];
  const publisherEmail = new Map<string, string | null>();
  if (publisherIds.length > 0) {
    const { data: pubs } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .in("id", publisherIds);
    for (const p of (pubs ?? []) as Array<{ id: string; email: string | null }>) {
      publisherEmail.set(p.id, p.email);
    }
  }

  const state = await loadLegalVersionState();
  const coverage = await acceptanceCoverage(state.tos.current, state.privacy.current);

  return c.json({
    documents: documents.map((d) => ({
      ...d,
      published_by_email: d.published_by
        ? publisherEmail.get(d.published_by) ?? null
        : null,
    })),
    current: { tos: state.tos.current, privacy: state.privacy.current },
    required_since: {
      tos: state.tos.requiredSince,
      privacy: state.privacy.requiredSince,
    },
    coverage,
  });
});

// ── POST / — publish a new version (super_admin + step-up; audited) ──────────
adminLegalRoutes.post("/", async (c) => {
  // Destructive (forces every user to re-accept): super_admin + fresh MFA step-up.
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin access required to publish a legal version" }, 403);
  }
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  let body: {
    kind?: unknown;
    version?: unknown;
    effective_date?: unknown;
    url?: unknown;
    body?: unknown;
    requires_reacceptance?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!VALID_KINDS.has(kind)) {
    return c.json({ error: "kind must be 'tos' or 'privacy'" }, 400);
  }
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!VERSION_RE.test(version)) {
    return c.json({ error: "version must be a date in YYYY-MM-DD format" }, 400);
  }
  // effective_date defaults to the version date when omitted.
  const effectiveRaw = typeof body.effective_date === "string"
    ? body.effective_date.trim()
    : "";
  const effectiveDate = effectiveRaw || version;
  if (!VERSION_RE.test(effectiveDate)) {
    return c.json({ error: "effective_date must be a date in YYYY-MM-DD format" }, 400);
  }

  const url = typeof body.url === "string" && body.url.trim()
    ? body.url.trim().slice(0, 2000)
    : null;
  const docBody = typeof body.body === "string" && body.body.trim()
    ? body.body.trim()
    : null;
  // Default true: a published version forces re-acceptance unless explicitly a
  // minor (non-material) edit.
  const requiresReacceptance = body.requires_reacceptance === false ? false : true;

  const { data: inserted, error } = await supabaseAdmin
    .from("legal_documents")
    .insert({
      kind,
      version,
      effective_date: effectiveDate,
      url,
      body: docBody,
      requires_reacceptance: requiresReacceptance,
      published_by: c.get("userId"),
    })
    .select("id")
    .single();
  if (error) {
    // Unique (kind, version) violation → already published.
    if (error.code === "23505") {
      return c.json({ error: `Version ${version} of ${kind} is already published` }, 409);
    }
    console.error("[admin-legal] publish failed:", error.message);
    return c.json({ error: "Failed to publish legal version" }, 500);
  }

  const newId = (inserted as { id: string }).id;
  await writeAuditLog(c, {
    action: "compliance.legal_publish",
    targetType: "legal_document",
    targetId: newId,
    details: {
      kind,
      version,
      effective_date: effectiveDate,
      requires_reacceptance: requiresReacceptance,
    },
  });

  return c.json({ ok: true, id: newId });
});
