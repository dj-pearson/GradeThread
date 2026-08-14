import { useNavigate, useSearchParams } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWorkspace } from "@/hooks/use-workspace";
import { AccountHubContext } from "@/hooks/use-account-hub";
import type { WorkspaceCapability } from "@/lib/workspace-permissions";
import { SettingsPage } from "@/pages/settings";
import { BillingPage } from "@/pages/billing";
import { TeamPage } from "@/pages/team";
import { ApiKeysPage } from "@/pages/api-keys";
import { ReferralsPage } from "@/pages/referrals";

// Unified Account hub (US-741). One destination with tabs, composed from the
// existing standalone pages rather than rewriting them — radix Tabs unmounts
// inactive content, so only the open tab's page mounts/fetches. Children render
// with AccountHubContext.embedded = true so each page suppresses its own
// PageHeader (US-1441) — the tab label names the section, so a per-page heading
// would just duplicate it and stack a second title under this tab strip.
const TABS: { value: string; label: string; requires?: WorkspaceCapability }[] =
  [
    { value: "settings", label: "Settings" },
    { value: "billing", label: "Billing", requires: "manage_billing" },
    { value: "team", label: "Team" },
    { value: "api-keys", label: "API keys", requires: "manage_api_keys" },
    { value: "referrals", label: "Referrals" },
  ];

export function AccountPage({
  /**
   * US-2511: which tab a LEGACY standalone path opens on. `/dashboard/billing`
   * and friends now render this hub with the matching tab preselected, instead
   * of rendering the bare page with no tab strip and no way back to Account.
   *
   * They RENDER rather than redirect on purpose. Those five paths are baked into
   * things we do not control on this side: Stripe checkout return URLs
   * (`payments.ts` → `/dashboard/billing?checkout=success&product=…&credits=…`,
   * and the same for api-keys), the legally-required cancellation link
   * (`?cancel=1`), the drip's subscribe CTA (`?upgrade=pro`), the unsubscribe
   * link (`/dashboard/settings?tab=notifications#email-preferences`) and Stripe
   * Connect's return (`/dashboard/referrals?connect=done`). A client-side
   * redirect would put an extra hop — and a chance to drop a query param or the
   * hash — in the middle of a money path. Rendering keeps every one of those
   * URLs working byte for byte.
   */
  initialTab,
}: { initialTab?: string } = {}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useWorkspace();

  // Mirror the per-capability gating the sidebar used to apply, so members
  // without billing/API rights don't see those tabs.
  const visible = TABS.filter((t) => !t.requires || can(t.requires));
  const allowed = new Set(visible.map((t) => t.value));

  // `?tab=` is ALSO owned by a child — the unsubscribe email deep-links
  // `/dashboard/settings?tab=notifications`, which settings.tsx reads for its
  // own section. So an unrecognised value is not an error: it belongs to the
  // child, and the outer tab falls back to `initialTab`.
  const raw = params.get("tab");
  const fallback = initialTab && allowed.has(initialTab) ? initialTab : "settings";
  const tab = raw && allowed.has(raw) ? raw : fallback;

  function onTab(next: string) {
    // From a legacy standalone path, the first tab click moves the user onto the
    // canonical hub URL rather than leaving them on /dashboard/billing?tab=team.
    if (initialTab) {
      navigate(`/dashboard/account?tab=${next}`, { replace: true });
      return;
    }
    // Deep-linkable + replace so tab switches don't pile up history entries.
    const n = new URLSearchParams(params);
    n.set("tab", next);
    setParams(n, { replace: true });
  }

  return (
    <AccountHubContext.Provider value={{ embedded: true }}>
      <Tabs value={tab} onValueChange={onTab} className="space-y-6">
        <TabsList className="flex-wrap">
          {visible.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="settings">
          <SettingsPage />
        </TabsContent>
        {allowed.has("billing") && (
          <TabsContent value="billing">
            <BillingPage />
          </TabsContent>
        )}
        <TabsContent value="team">
          <TeamPage />
        </TabsContent>
        {allowed.has("api-keys") && (
          <TabsContent value="api-keys">
            <ApiKeysPage />
          </TabsContent>
        )}
        <TabsContent value="referrals">
          <ReferralsPage />
        </TabsContent>
      </Tabs>
    </AccountHubContext.Provider>
  );
}
