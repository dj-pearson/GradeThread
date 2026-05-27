import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import type { FlipdeskPlanKey } from "@/lib/constants";

// ── edgeFetch (US-209 + US-210) ─────────────────────────────────
//
// Wrapper around fetch() for every call to the Hono edge service. Adds:
//   • Auth bearer from the current Supabase session (skip with unauthenticated)
//   • Soft-warning toast when the response carries X-Plan-Warning (US-209)
//   • Hard-cap upgrade dialog when the response is 402 PAYMENT_REQUIRED (US-210)
//
// All edge-side errors (other than 402) bubble up unchanged — callers still
// inspect res.ok / res.status the same way.
//
// Migration plan: new code goes through edgeFetch. Existing hooks that call
// fetch() directly with edgeApiUrl() should be migrated incrementally — they
// keep working (just without the gate handling).

export interface EdgeFetchOptions extends RequestInit {
  /** Skip the Authorization header (for the rare unauthenticated path). */
  unauthenticated?: boolean;
  /**
   * Don't surface gate UI (dialog/toast). Caller handles 402 + X-Plan-Warning
   * themselves. Use sparingly — for endpoints where the caller needs custom
   * messaging (e.g. the new-submission flow).
   */
  silentGate?: boolean;
  /**
   * Pre-parsed body for convenience; sets Content-Type: application/json and
   * stringifies. Just shorthand — the standard `body` field still works.
   */
  json?: unknown;
}

export async function edgeFetch(
  path: string,
  opts: EdgeFetchOptions = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);

  if (!opts.unauthenticated) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      throw new Error("You must be signed in.");
    }
    headers.set("Authorization", `Bearer ${session.access_token}`);
  }

  let body = opts.body;
  if (opts.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.json);
  }

  const url = path.startsWith("http") ? path : `${edgeApiUrl()}${path}`;
  const res = await fetch(url, { ...opts, headers, body });

  if (!opts.silentGate) {
    const warn = res.headers.get("X-Plan-Warning");
    if (warn) handlePlanWarning(warn);

    if (res.status === 402) {
      // Clone so the caller can still consume the body downstream.
      const cloned = res.clone();
      const data = await cloned.json().catch(() => ({} as Record<string, unknown>));
      handlePaymentRequired(data);
    }
  }

  return res;
}

// ── Soft warning (US-209) ───────────────────────────────────────
//
// Header format: "CAP_80;kind=activeListings;used=200;limit=250"
// We show one toast per cap, with sonner's id-based dedup preventing
// repeated stacking when the same warning fires across multiple requests.

const FRIENDLY_KIND: Record<string, string> = {
  activeListings: "active listings",
  aiActions: "AI actions this month",
  marketplaces: "connected marketplaces",
  includedGrades: "included grades this month",
};

function handlePlanWarning(header: string) {
  const parsed = parsePlanWarning(header);
  if (!parsed) return;
  const { kind, used, limit } = parsed;

  const friendly = FRIENDLY_KIND[kind] ?? kind;
  const pct = Math.round((used / limit) * 100);

  toast.warning(`You've used ${pct}% of your ${friendly}`, {
    id: `plan_warning_${kind}`,
    description: `Currently at ${used} of ${limit}. Upgrade for more headroom.`,
    duration: 6000,
    action: {
      label: "Upgrade",
      onClick: () => {
        // Defer import to avoid circular dep at module load.
        import("@/stores/upgrade-dialog-store").then((m) => {
          m.useUpgradeDialogStore.getState().show({
            reason: { type: "cap", kind: kind as never, used, limit },
            requiredPlan: requiredPlanForCap(kind, limit + 1),
          });
        });
      },
    },
  });
}

function parsePlanWarning(
  header: string,
): { kind: string; used: number; limit: number } | null {
  // Format: CAP_80;kind=<kind>;used=<n>;limit=<n>
  const parts = header.split(";").map((p) => p.trim());
  if (parts[0] !== "CAP_80") return null;
  const map: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const [k, v] = p.split("=");
    if (k && v) map[k] = v;
  }
  const used = Number.parseInt(map.used ?? "", 10);
  const limit = Number.parseInt(map.limit ?? "", 10);
  if (!map.kind || !Number.isFinite(used) || !Number.isFinite(limit)) return null;
  return { kind: map.kind, used, limit };
}

// ── Hard cap (US-210) ───────────────────────────────────────────
//
// Edge 402 response body shapes (set by services/edge-functions/src/lib/plan-gate.ts):
//   { error: "CAP_REACHED", cap, used, limit, delta, plan, requiredPlan }
//   { error: "FEATURE_LOCKED", feature, plan, requiredPlan }

function handlePaymentRequired(body: Record<string, unknown>) {
  const error = body.error as string | undefined;
  const currentPlan = body.plan as FlipdeskPlanKey | undefined;
  const requiredPlan = (body.requiredPlan as FlipdeskPlanKey | undefined) ?? "pro";

  if (error === "CAP_REACHED") {
    const kind = body.cap as
      | "activeListings"
      | "aiActions"
      | "marketplaces"
      | "includedGrades";
    useUpgradeDialogStore.getState().show({
      reason: {
        type: "cap",
        kind,
        used: typeof body.used === "number" ? body.used : undefined,
        limit: typeof body.limit === "number" ? body.limit : undefined,
        delta: typeof body.delta === "number" ? body.delta : undefined,
      },
      currentPlan,
      requiredPlan,
      offerCreditPack: kind === "includedGrades",
    });
    return;
  }

  if (error === "FEATURE_LOCKED") {
    const feature = (body.feature as string | undefined) ?? "this feature";
    useUpgradeDialogStore.getState().show({
      reason: { type: "feature", feature },
      currentPlan,
      requiredPlan,
    });
    return;
  }

  // Unknown 402 — fall back to a generic toast so the user knows something happened.
  toast.error("Action blocked", {
    description:
      typeof body.error === "string"
        ? body.error
        : "Your plan doesn't include this. Open Billing to upgrade.",
  });
}

// ── Helpers ─────────────────────────────────────────────────────
//
// Mirrors src/lib/constants.ts FLIPDESK_PLANS — kept local to avoid an
// import cycle with the constants file (which has no other deps and we
// want to keep that way).

const LIMITS_BY_PLAN_FOR_CAP: Record<
  string,
  Array<{ plan: FlipdeskPlanKey; limit: number }>
> = {
  activeListings: [
    { plan: "starter", limit: 250 },
    { plan: "pro", limit: 1000 },
    { plan: "business", limit: -1 },
  ],
  aiActions: [
    { plan: "starter", limit: 200 },
    { plan: "pro", limit: 1000 },
    { plan: "business", limit: 5000 },
  ],
  marketplaces: [
    { plan: "starter", limit: 2 },
    { plan: "pro", limit: -1 },
    { plan: "business", limit: -1 },
  ],
  includedGrades: [
    { plan: "starter", limit: 10 },
    { plan: "pro", limit: 30 },
    { plan: "business", limit: 75 },
  ],
};

function requiredPlanForCap(kind: string, needed: number): FlipdeskPlanKey {
  const ladder = LIMITS_BY_PLAN_FOR_CAP[kind];
  if (!ladder) return "pro";
  for (const step of ladder) {
    if (step.limit === -1 || needed <= step.limit) return step.plan;
  }
  return "business";
}
