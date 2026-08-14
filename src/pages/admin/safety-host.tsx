import { lazy } from "react";
import { ShieldAlert } from "lucide-react";
import { AdminTabHost } from "@/pages/admin/admin-tab-host";
import {
  SAFETY_VIEWS,
  resolveSafetyView,
  type SafetyView,
} from "@/pages/admin/admin-host-tabs";

// US-2559: Moderation, Abuse & Fraud and Abuse Signals were three sidebar
// entries covering one domain.
//
// VERIFIED as a MERGE: Moderation is the queue an operator DRAINS (submissions,
// listings, photos, certificate reports), Fraud is the live cross-tenant
// aggregate they consult while draining it, and Signals is the durable,
// triageable ledger the abuse-scan cron writes. Three jobs, one destination.
//
// Rate Limits and Passport Integrity stay their own entries: neither is abuse
// triage — one is capacity administration, the other is ledger integrity.

const ModerationPage = lazy(() =>
  import("@/pages/admin/moderation").then((m) => ({ default: m.AdminModerationPage })),
);
const FraudPage = lazy(() =>
  import("@/pages/admin/fraud").then((m) => ({ default: m.AdminFraudPage })),
);
const SignalsPage = lazy(() =>
  import("@/pages/admin/safety-signals").then((m) => ({ default: m.AdminSafetySignalsPage })),
);

const VIEWS = [
  { value: "moderation", label: "Moderation", Component: ModerationPage },
  { value: "fraud", label: "Abuse & fraud", Component: FraudPage },
  { value: "signals", label: "Signals", Component: SignalsPage },
] satisfies ReadonlyArray<{ value: SafetyView; label: string; Component: React.ComponentType }>;

// The tab order IS the order declared in admin-host-tabs.ts, and the first is
// the default. Asserted in the guard so the two cannot drift.
void SAFETY_VIEWS;

export function AdminSafetyHostPage() {
  return (
    <AdminTabHost
      title="Trust & Safety"
      subtitle="The moderation queue, the live abuse aggregate, and the durable signal ledger."
      icon={ShieldAlert}
      views={VIEWS}
      resolve={resolveSafetyView}
    />
  );
}
