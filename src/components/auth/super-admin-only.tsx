import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * US-2357 AC4: make `superAdminOnly` in the admin nav mean something.
 *
 * The sidebar hid two links from plain admins — Incentives and Audit Log —
 * while `<AdminRoute>` only checks for admin-or-better. Typing either URL
 * rendered the whole page. A nav that hides a link it does not gate is a nav
 * that lies about the shape of the product, and the operator reading it is the
 * person least able to check.
 *
 * WHAT THIS IS NOT. This is not a security boundary and must not be counted as
 * one. Every mutation behind these pages is enforced server-side, by scope plus
 * an MFA step-up, which is where the real gate lives — and where a client check
 * can be removed with devtools. US-2352 owns the actual hole here (the audit-log
 * EXPORT endpoint is reachable by any admin, and no amount of client gating
 * closes that). This fixes what the navigation claims, nothing more.
 */
export function SuperAdminOnly({ children }: { children: ReactNode }) {
  const { profile } = useAuth();

  // `profile` is loaded by <AdminRoute>, which renders a spinner until it
  // resolves and bounces a non-admin — so by the time this mounts the role is
  // known. Treat an absent profile as not-super rather than as "still loading":
  // guessing permissively for one render is how a gate becomes decorative.
  if (profile?.role === "super_admin") return <>{children}</>;

  return (
    <EmptyState
      icon={ShieldAlert}
      title="Super admin only"
      description="This page is limited to super admins. If you need access, ask one to grant it — the actions here are also enforced server-side, so the page would not work without the role."
    />
  );
}
