import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Gift, Loader2, Save, RefreshCw, Tag, DollarSign, ArrowRight } from "lucide-react";

// US-1069 — Incentives: one admin surface for referral & promo economics.
//
// Consolidates the two admin-tunable referral settings (reward economics +
// referred-user signup incentive) into structured forms, and links the related
// coupon/promo and pricing surfaces. The settings themselves live in the
// system_settings registry, so each Save PUTs /api/admin/settings/:key — which is
// super_admin + MFA step-up gated and audited server-side (US-884), keeping the
// referral grant logic the single source of truth.

interface Setting {
  key: string;
  value: unknown;
  value_type: string;
  default_value: unknown;
  description: string | null;
  category: string;
}

interface CategoryGroup {
  category: string;
  settings: Setting[];
}

interface SettingsResponse {
  groups: CategoryGroup[];
  total: number;
}

const REWARD_CONFIG_KEY = "referral.reward_config";
const SIGNUP_INCENTIVE_KEY = "referral.referred_signup_incentive";

interface RewardConfig {
  referrer_credits: number;
  referred_credits: number;
  qualification_window_days: number;
  per_referrer_cap: number;
}

interface SignupIncentive {
  enabled: boolean;
  bonus_credits: number;
  free_month_coupon_id: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function findSetting(data: SettingsResponse | undefined, key: string): Setting | undefined {
  return data?.groups.flatMap((g) => g.settings).find((s) => s.key === key);
}

// Coerce a number-input draft (string) to a non-negative integer.
function toNonNegInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function RewardConfigCard({
  setting,
  onSaved,
  onStepUpRequired,
}: {
  setting: Setting;
  onSaved: () => void;
  onStepUpRequired: (retry: () => void) => void;
}) {
  const stored = (setting.value ?? {}) as Partial<RewardConfig>;
  const [referrer, setReferrer] = useState(String(stored.referrer_credits ?? 5));
  const [referred, setReferred] = useState(String(stored.referred_credits ?? 3));
  const [windowDays, setWindowDays] = useState(String(stored.qualification_window_days ?? 0));
  const [cap, setCap] = useState(String(stored.per_referrer_cap ?? 0));
  const [saving, setSaving] = useState(false);

  // Re-sync drafts when the server value changes after a refetch.
  useEffect(() => {
    const s = (setting.value ?? {}) as Partial<RewardConfig>;
    setReferrer(String(s.referrer_credits ?? 5));
    setReferred(String(s.referred_credits ?? 3));
    setWindowDays(String(s.qualification_window_days ?? 0));
    setCap(String(s.per_referrer_cap ?? 0));
  }, [setting.value]);

  async function save() {
    const value: RewardConfig = {
      referrer_credits: toNonNegInt(referrer),
      referred_credits: toNonNegInt(referred),
      qualification_window_days: toNonNegInt(windowDays),
      per_referrer_cap: toNonNegInt(cap),
    };
    setSaving(true);
    try {
      const res = await edgeFetch(`/api/admin/settings/${encodeURIComponent(REWARD_CONFIG_KEY)}`, {
        method: "PUT",
        json: { value },
        silentGate: true,
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && (j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        onStepUpRequired(() => void save());
        return;
      }
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Save failed");
        return;
      }
      toast.success("Referral rewards updated");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Referral rewards</CardTitle>
        <CardDescription>
          Credits each party earns per granted referral, plus the qualification window and a
          per-referrer cap. Read at grant time — changes take effect immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="referrer-credits">Referrer credits</Label>
            <Input
              id="referrer-credits"
              type="number"
              min={0}
              step={1}
              value={referrer}
              onChange={(e) => setReferrer(e.target.value)}
              className="max-w-[160px]"
            />
            <p className="text-xs text-muted-foreground">Granted to the referrer per referral.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="referred-credits">Referred credits</Label>
            <Input
              id="referred-credits"
              type="number"
              min={0}
              step={1}
              value={referred}
              onChange={(e) => setReferred(e.target.value)}
              className="max-w-[160px]"
            />
            <p className="text-xs text-muted-foreground">Granted to the new (referred) user.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="window-days">Qualification window (days)</Label>
            <Input
              id="window-days"
              type="number"
              min={0}
              step={1}
              value={windowDays}
              onChange={(e) => setWindowDays(e.target.value)}
              className="max-w-[160px]"
            />
            <p className="text-xs text-muted-foreground">
              Referred user must reach a first paid action within this many days. 0 = no window.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="per-referrer-cap">Per-referrer cap</Label>
            <Input
              id="per-referrer-cap"
              type="number"
              min={0}
              step={1}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="max-w-[160px]"
            />
            <p className="text-xs text-muted-foreground">
              Max rewarded referrals per referrer. 0 = unlimited.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save rewards
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SignupIncentiveCard({
  setting,
  onSaved,
  onStepUpRequired,
}: {
  setting: Setting;
  onSaved: () => void;
  onStepUpRequired: (retry: () => void) => void;
}) {
  const stored = (setting.value ?? {}) as Partial<SignupIncentive>;
  const [enabled, setEnabled] = useState(stored.enabled ?? true);
  const [bonus, setBonus] = useState(String(stored.bonus_credits ?? 3));
  const [coupon, setCoupon] = useState(stored.free_month_coupon_id ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const s = (setting.value ?? {}) as Partial<SignupIncentive>;
    setEnabled(s.enabled ?? true);
    setBonus(String(s.bonus_credits ?? 3));
    setCoupon(s.free_month_coupon_id ?? "");
  }, [setting.value]);

  async function save() {
    const trimmed = coupon.trim();
    const value: SignupIncentive = {
      enabled,
      bonus_credits: toNonNegInt(bonus),
      free_month_coupon_id: trimmed.length > 0 ? trimmed : null,
    };
    setSaving(true);
    try {
      const res = await edgeFetch(`/api/admin/settings/${encodeURIComponent(SIGNUP_INCENTIVE_KEY)}`, {
        method: "PUT",
        json: { value },
        silentGate: true,
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && (j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        onStepUpRequired(() => void save());
        return;
      }
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Save failed");
        return;
      }
      toast.success("Signup incentive updated");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Referred-user signup incentive</CardTitle>
        <CardDescription>
          The welcome a referred new user gets the moment they redeem a ?ref= link (before any paid
          action): instant bonus credits and/or a free-month / %-off Stripe coupon applied at their
          next subscription checkout.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Switch checked={enabled} onCheckedChange={setEnabled} id="incentive-enabled" />
          <Label htmlFor="incentive-enabled" className="cursor-pointer">
            {enabled ? "Enabled" : "Disabled"}
          </Label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bonus-credits">Welcome credits</Label>
            <Input
              id="bonus-credits"
              type="number"
              min={0}
              step={1}
              value={bonus}
              onChange={(e) => setBonus(e.target.value)}
              disabled={!enabled}
              className="max-w-[160px]"
            />
            <p className="text-xs text-muted-foreground">Granted immediately on redeem.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="free-month-coupon">Free-month / %-off coupon</Label>
            <Input
              id="free-month-coupon"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
              disabled={!enabled}
              placeholder="Stripe coupon id (optional)"
            />
            <p className="text-xs text-muted-foreground">
              Applied at the next subscription checkout. Leave blank for credits-only.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save incentive
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function AdminIncentivesPage() {
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const query = useQuery({
    queryKey: ["admin-incentives-settings"],
    queryFn: () => getJson<SettingsResponse>("/api/admin/settings"),
  });

  function handleStepUpRequired(retryFn: () => void) {
    setRetry(() => retryFn);
    setStepUpOpen(true);
  }

  const rewardSetting = findSetting(query.data, REWARD_CONFIG_KEY);
  const incentiveSetting = findSetting(query.data, SIGNUP_INCENTIVE_KEY);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Incentives"
        subtitle={
          <>
            Referral &amp; promo economics in one place. Changes are audited and require a fresh
            second factor.
          </>
        }
        icon={Gift}
        actions={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        }
      />

      {query.isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-destructive">
            {(query.error as Error)?.message ?? "Failed to load incentives."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {rewardSetting ? (
            <RewardConfigCard
              setting={rewardSetting}
              onSaved={() => void query.refetch()}
              onStepUpRequired={handleStepUpRequired}
            />
          ) : null}
          {incentiveSetting ? (
            <SignupIncentiveCard
              setting={incentiveSetting}
              onSaved={() => void query.refetch()}
              onStepUpRequired={handleStepUpRequired}
            />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Related surfaces</CardTitle>
              <CardDescription>Coupons / promo codes and plan pricing tie into the same economics.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Button asChild variant="outline" className="justify-between">
                <Link to="/admin/coupons">
                  <span className="flex items-center gap-2">
                    <Tag className="h-4 w-4" />
                    Coupons &amp; promo codes
                  </span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-between">
                <Link to="/admin/pricing">
                  <span className="flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Plans &amp; pricing
                  </span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}
