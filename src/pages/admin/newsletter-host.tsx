import { lazy } from "react";
import { Mailbox } from "lucide-react";
import { AdminTabHost } from "@/pages/admin/admin-tab-host";
import {
  NEWSLETTER_VIEWS,
  resolveNewsletterView,
  type NewsletterView,
} from "@/pages/admin/admin-host-tabs";

// US-2559: four sidebar entries — Newsletter Health, Newsletter Console,
// Subscribers and Suppressions — are one domain.
//
// VERIFIED as a MERGE: Health is deliverability measurement, the Console is the
// per-issue lifecycle, Subscribers is the standalone non-user list, and
// Suppressions is the do-not-mail ledger. Different jobs, one destination.
//
// "health" is the default because /admin/growth/newsletter already WAS the
// Health page. Promoting it to host must not change what an existing bookmark
// shows.

const HealthPage = lazy(() =>
  import("@/pages/admin/newsletter-analytics").then((m) => ({ default: m.AdminNewsletterAnalyticsPage })),
);
const ConsolePage = lazy(() =>
  import("@/pages/admin/newsletter").then((m) => ({ default: m.AdminNewsletterConsolePage })),
);
const SubscribersPage = lazy(() =>
  import("@/pages/admin/newsletter-subscribers").then((m) => ({ default: m.AdminNewsletterSubscribersPage })),
);
const SuppressionsPage = lazy(() =>
  import("@/pages/admin/suppressions").then((m) => ({ default: m.AdminSuppressionsPage })),
);

const VIEWS = [
  { value: "health", label: "Health", Component: HealthPage },
  { value: "console", label: "Console", Component: ConsolePage },
  { value: "subscribers", label: "Subscribers", Component: SubscribersPage },
  { value: "suppressions", label: "Suppressions", Component: SuppressionsPage },
] satisfies ReadonlyArray<{ value: NewsletterView; label: string; Component: React.ComponentType }>;

// The tab order IS the order declared in admin-host-tabs.ts, and the first is
// the default. Asserted in the guard so the two cannot drift.
void NEWSLETTER_VIEWS;

export function AdminNewsletterHostPage() {
  return (
    <AdminTabHost
      title="Newsletter"
      subtitle="Deliverability, the issue lifecycle, who is subscribed and who must never be mailed."
      icon={Mailbox}
      views={VIEWS}
      resolve={resolveNewsletterView}
    />
  );
}
