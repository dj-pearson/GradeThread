// US-3299: the sale-campaign editor.
//
// Lives under the plan editor on /admin/pricing, deliberately: setting a sale is
// a pricing decision, and the operator wants the list prices on screen while
// making it.
//
// The live preview is the point of the dialog. A percent typed as 200 or an
// amount typed in dollars instead of cents is caught by reading "Starter monthly
// $29 becomes $0" before it reaches Stripe, not by a constraint violation after.

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { usePricingPlans } from "@/hooks/use-pricing-plans";
import {
  type DiscountPackage,
  discountPackageGroups,
  packageSignature,
  targetSignatures,
} from "@/lib/discount-packages";
import {
  type DiscountCampaign,
  type DiscountTarget,
  discountedCents,
  dollarsExact,
  isCampaignLive,
} from "@/lib/discounts";

interface AdminCampaign extends DiscountCampaign {
  stripe_sync_error: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

type Status = "live" | "scheduled" | "expired" | "disabled" | "unsynced";

function statusOf(c: AdminCampaign, nowMs: number): Status {
  if (!c.enabled) return "disabled";
  if (!c.stripe_coupon_id) return "unsynced";
  if (Date.parse(c.ends_at) <= nowMs) return "expired";
  if (Date.parse(c.starts_at) > nowMs) return "scheduled";
  return "live";
}

const STATUS_LABEL: Record<Status, string> = {
  live: "Live",
  scheduled: "Scheduled",
  expired: "Expired",
  disabled: "Disabled",
  unsynced: "Not synced",
};

function StatusBadge({ status }: { status: Status }) {
  if (status === "live") {
    return <Badge className="bg-brand-red text-white hover:bg-brand-red">Live</Badge>;
  }
  if (status === "unsynced") {
    return <Badge variant="destructive">Not synced</Badge>;
  }
  return <Badge variant={status === "scheduled" ? "default" : "secondary"}>{STATUS_LABEL[status]}</Badge>;
}

const STATUS_RANK: Record<Status, number> = {
  live: 0,
  unsynced: 1,
  scheduled: 2,
  disabled: 3,
  expired: 4,
};

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in LOCAL time, not an ISO string. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${
    pad(d.getMinutes())
  }`;
}

interface DraftState {
  id: string | null;
  name: string;
  description: string;
  discountType: "percent" | "amount";
  /** Percent as typed ("20"), or DOLLARS as typed ("5.00") — converted on save. */
  value: string;
  startsAt: string;
  endsAt: string;
  appliesToAll: boolean;
  selected: Set<string>;
}

function emptyDraft(): DraftState {
  const now = new Date();
  const inAMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    id: null,
    name: "",
    description: "",
    discountType: "percent",
    value: "20",
    startsAt: toLocalInput(now.toISOString()),
    endsAt: toLocalInput(inAMonth.toISOString()),
    appliesToAll: true,
    selected: new Set(),
  };
}

function draftFrom(c: AdminCampaign): DraftState {
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? "",
    discountType: c.discount_type,
    value: c.discount_type === "percent"
      ? String(c.percent_off ?? "")
      : ((c.amount_off_cents ?? 0) / 100).toFixed(2),
    startsAt: toLocalInput(c.starts_at),
    endsAt: toLocalInput(c.ends_at),
    appliesToAll: c.applies_to_all,
    selected: targetSignatures(c.targets),
  };
}

export function DiscountCampaignsPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const qc = useQueryClient();
  const { plans } = usePricingPlans();
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const groups = useMemo(() => discountPackageGroups(plans), [plans]);
  const now = Date.now();

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-discount-campaigns"],
    queryFn: async (): Promise<{ campaigns: AdminCampaign[] }> => {
      const res = await edgeFetch("/api/admin/discounts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load discount campaigns.");
      return json;
    },
    staleTime: 30_000,
  });

  const campaigns = useMemo(() => {
    const rows = data?.campaigns ?? [];
    return [...rows].sort((a, b) => {
      const rank = STATUS_RANK[statusOf(a, now)] - STATUS_RANK[statusOf(b, now)];
      if (rank !== 0) return rank;
      return Date.parse(b.starts_at) - Date.parse(a.starts_at);
    });
  }, [data, now]);

  // Step-up-aware runner, same shape as the plan editor above it.
  async function run(doFetch: () => Promise<Response>, onOk: () => void) {
    setWorking(true);
    try {
      const res = await doFetch();
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => run(doFetch, onOk));
          setStepUpOpen(true);
          return;
        }
        toast.error((j as { error?: string })?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string }).error ?? "Save failed");
        return;
      }
      onOk();
    } finally {
      setWorking(false);
    }
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ["admin-discount-campaigns"] });
    // Every public pricing surface reads this key.
    qc.invalidateQueries({ queryKey: ["discount-campaigns"] });
  }

  function save() {
    if (!draft) return;
    const payload = buildPayload(draft, groups);
    if (!payload.ok) {
      toast.error(payload.error);
      return;
    }
    const path = draft.id ? `/api/admin/discounts/${draft.id}` : "/api/admin/discounts";
    run(
      () =>
        edgeFetch(path, {
          method: draft.id ? "PUT" : "POST",
          json: payload.body,
          silentGate: true,
        }),
      () => {
        toast.success(draft.id ? "Campaign updated" : "Campaign created");
        setDraft(null);
        refresh();
      },
    );
  }

  function toggle(c: AdminCampaign) {
    run(
      () =>
        edgeFetch(`/api/admin/discounts/${c.id}/toggle`, {
          method: "POST",
          json: { enabled: !c.enabled },
          silentGate: true,
        }),
      () => {
        toast.success(c.enabled ? "Campaign disabled" : "Campaign enabled");
        refresh();
      },
    );
  }

  function resync(c: AdminCampaign) {
    run(
      () => edgeFetch(`/api/admin/discounts/${c.id}/resync`, { method: "POST", json: {}, silentGate: true }),
      () => {
        toast.success("Stripe coupon re-minted");
        refresh();
      },
    );
  }

  function remove(c: AdminCampaign) {
    run(
      () => edgeFetch(`/api/admin/discounts/${c.id}`, { method: "DELETE", silentGate: true }),
      () => {
        toast.success("Campaign deleted");
        refresh();
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Sales &amp; discounts</CardTitle>
            <CardDescription>
              A campaign takes a percent or a dollar amount off the packages you pick, between the
              dates you set. It starts and ends on its own. Stripe honors it at checkout.
            </CardDescription>
          </div>
          {isSuperAdmin && (
            <Button onClick={() => setDraft(emptyDraft())}>
              <Plus className="mr-2 h-4 w-4" />
              New campaign
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle className="h-4 w-4" />
            {(error as Error).message}
          </div>
        )}

        {isLoading
          ? <Skeleton className="h-40 w-full" />
          : campaigns.length === 0
          ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No campaigns yet. Prices show as normal.
            </p>
          )
          : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Applies to</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns.map((c) => {
                    const status = statusOf(c, now);
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">
                          {c.name}
                          {c.stripe_sync_error && (
                            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                              {c.stripe_sync_error}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          {c.discount_type === "percent"
                            ? `${Number(c.percent_off)}%`
                            : dollarsExact(Number(c.amount_off_cents ?? 0))}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {c.applies_to_all
                            ? "All packages"
                            : `${c.targets.length} package${c.targets.length === 1 ? "" : "s"}`}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {new Date(c.starts_at).toLocaleDateString()} to{" "}
                          {new Date(c.ends_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={status} />
                        </TableCell>
                        <TableCell className="text-right">
                          {isSuperAdmin && (
                            <div className="flex justify-end gap-2">
                              {/* US-2450: every aria-label carries the campaign
                                  name. Without it a screen reader announces
                                  "Edit" once per row with nothing to say which
                                  sale it edits. */}
                              {status === "unsynced" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={working}
                                  onClick={() => resync(c)}
                                  aria-label={`Retry Stripe sync for ${c.name}`}
                                >
                                  <RefreshCw className="mr-1 h-3 w-3" />
                                  Retry
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={working}
                                onClick={() => setDraft(draftFrom(c))}
                                aria-label={`Edit ${c.name}`}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={working}
                                onClick={() => toggle(c)}
                                aria-label={c.enabled
                                  ? `Disable ${c.name}`
                                  : `Enable ${c.name}`}
                              >
                                {c.enabled ? "Disable" : "Enable"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={working}
                                onClick={() => remove(c)}
                                aria-label={`Delete ${c.name}`}
                              >
                                <Trash2 className="h-4 w-4 text-red-600" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
      </CardContent>

      <CampaignDialog
        draft={draft}
        setDraft={setDraft}
        groups={groups}
        working={working}
        onSave={save}
        // An edit to a live campaign replaces its Stripe coupon, which fails any
        // checkout session already open against the old one.
        warnLive={Boolean(
          draft?.id && campaigns.some((c) => c.id === draft.id && isCampaignLive(c, now)),
        )}
      />

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </Card>
  );
}

// ── the dialog ──────────────────────────────────────────────────────────────

interface DialogProps {
  draft: DraftState | null;
  setDraft: (d: DraftState | null) => void;
  groups: ReturnType<typeof discountPackageGroups>;
  working: boolean;
  warnLive: boolean;
  onSave: () => void;
}

function CampaignDialog({ draft, setDraft, groups, working, warnLive, onSave }: DialogProps) {
  if (!draft) return null;

  const patch = (p: Partial<DraftState>) => setDraft({ ...draft, ...p });

  function togglePackage(pkg: DiscountPackage) {
    const sig = packageSignature(pkg);
    const next = new Set(draft!.selected);
    if (next.has(sig)) next.delete(sig);
    else next.add(sig);
    patch({ selected: next });
  }

  function toggleGroup(kind: string, on: boolean) {
    const next = new Set(draft!.selected);
    for (const g of groups) {
      if (g.kind !== kind) continue;
      for (const p of g.packages) {
        if (on) next.add(packageSignature(p));
        else next.delete(packageSignature(p));
      }
    }
    patch({ selected: next });
  }

  const preview = previewRows(draft, groups);

  return (
    <Dialog open onOpenChange={(o) => !o && setDraft(null)}>
      <DialogContent className="max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{draft.id ? "Edit campaign" : "New campaign"}</DialogTitle>
          <DialogDescription>
            Prices go back to normal on their own when the window closes.
          </DialogDescription>
        </DialogHeader>

        {warnLive && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This campaign is running. Changing the discount or the end date replaces its Stripe
              coupon, and any checkout page a customer already has open will stop working. Ending
              this one and starting a new one is safer.
            </span>
          </div>
        )}

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="dc-name">Name</Label>
              <Input
                id="dc-name"
                value={draft.name}
                maxLength={40}
                placeholder="Fall sale"
                onChange={(e) => patch({ name: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Customers see this on their Stripe receipt. 40 characters max.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dc-desc">Banner text (optional)</Label>
              <Input
                id="dc-desc"
                value={draft.description}
                maxLength={200}
                placeholder="20% off everything"
                onChange={(e) => patch({ description: e.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="dc-type">Type</Label>
              <Select
                value={draft.discountType}
                onValueChange={(v) => patch({ discountType: v as "percent" | "amount" })}
              >
                <SelectTrigger id="dc-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Percent off</SelectItem>
                  <SelectItem value="amount">Dollars off</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dc-value">
                {draft.discountType === "percent" ? "Percent" : "Dollars"}
              </Label>
              <Input
                id="dc-value"
                type="number"
                min="0"
                step={draft.discountType === "percent" ? "0.5" : "0.01"}
                value={draft.value}
                onChange={(e) => patch({ value: e.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="dc-start">Starts</Label>
              <Input
                id="dc-start"
                type="datetime-local"
                value={draft.startsAt}
                onChange={(e) => patch({ startsAt: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dc-end">Ends</Label>
              <Input
                id="dc-end"
                type="datetime-local"
                value={draft.endsAt}
                onChange={(e) => patch({ endsAt: e.target.value })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="dc-all">All packages</Label>
              <p className="text-xs text-muted-foreground">
                Everything you sell. Free tiers are skipped automatically.
              </p>
            </div>
            <Switch
              id="dc-all"
              checked={draft.appliesToAll}
              onCheckedChange={(v) => patch({ appliesToAll: v })}
            />
          </div>

          {!draft.appliesToAll && (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.kind} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-medium">{g.label}</p>
                    <div className="flex gap-2">
                      {/* US-2450: one "All" and one "None" per group, so the
                          label has to name the group it applies to. */}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleGroup(g.kind, true)}
                        aria-label={`Select all ${g.label}`}
                      >
                        All
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleGroup(g.kind, false)}
                        aria-label={`Clear all ${g.label}`}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {g.packages.map((p) => {
                      const sig = packageSignature(p);
                      return (
                        <label
                          key={sig}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-input"
                            checked={draft.selected.has(sig)}
                            onChange={() => togglePackage(p)}
                          />
                          <span>{p.label}</span>
                          <span className="ml-auto text-muted-foreground">
                            {dollarsExact(p.priceCents)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* The check that catches a fat-fingered number before Stripe does. */}
          <div className="rounded-lg border bg-muted/40 p-3">
            <p className="mb-2 text-sm font-medium">What customers will see</p>
            {preview.length === 0
              ? (
                <p className="text-sm text-muted-foreground">
                  Nothing selected, or nothing with a price above $0.
                </p>
              )
              : (
                <ul className="space-y-1 text-sm">
                  {preview.slice(0, 12).map((r) => (
                    <li key={r.sig} className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{r.label}</span>
                      <span>
                        <span className="text-muted-foreground line-through">{r.was}</span>{" "}
                        <span className="font-medium">{r.now}</span>
                      </span>
                    </li>
                  ))}
                  {preview.length > 12 && (
                    <li className="text-muted-foreground">
                      and {preview.length - 12} more
                    </li>
                  )}
                </ul>
              )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setDraft(null)} disabled={working}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={working}>
            {working ? "Saving…" : draft.id ? "Save changes" : "Create campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── draft → request body, and the preview that uses the same numbers ─────────

function draftValueCents(draft: DraftState): number {
  return Math.round(Number(draft.value) * 100);
}

/**
 * The campaign as the resolver would see it, so the preview runs the SAME
 * arithmetic the pricing pages will. A preview computed its own way is a preview
 * that can be right while the page is wrong.
 */
function draftAsCampaign(draft: DraftState): DiscountCampaign {
  const isPercent = draft.discountType === "percent";
  return {
    id: draft.id ?? "draft",
    name: draft.name,
    description: draft.description || null,
    discount_type: draft.discountType,
    percent_off: isPercent ? Number(draft.value) : null,
    amount_off_cents: isPercent ? null : draftValueCents(draft),
    starts_at: draft.startsAt,
    ends_at: draft.endsAt,
    enabled: true,
    targets: [],
    applies_to_all: true,
    stripe_coupon_id: "preview",
  };
}

function previewRows(draft: DraftState, groups: ReturnType<typeof discountPackageGroups>) {
  const campaign = draftAsCampaign(draft);
  const rows: { sig: string; label: string; was: string; now: string }[] = [];
  for (const g of groups) {
    for (const p of g.packages) {
      const sig = packageSignature(p);
      if (!draft.appliesToAll && !draft.selected.has(sig)) continue;
      if (p.priceCents <= 0) continue;
      const after = discountedCents(campaign, p.priceCents);
      rows.push({
        sig,
        label: p.label,
        was: dollarsExact(p.priceCents),
        now: dollarsExact(after),
      });
    }
  }
  return rows;
}

function buildPayload(
  draft: DraftState,
  groups: ReturnType<typeof discountPackageGroups>,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!draft.name.trim()) return { ok: false, error: "Give the campaign a name." };

  const num = Number(draft.value);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: "Enter a discount above zero." };
  }
  if (draft.discountType === "percent" && num > 100) {
    return { ok: false, error: "A percent discount cannot be over 100." };
  }

  const startMs = Date.parse(draft.startsAt);
  const endMs = Date.parse(draft.endsAt);
  if (!Number.isFinite(startMs)) return { ok: false, error: "Pick a start date." };
  if (!Number.isFinite(endMs)) return { ok: false, error: "Pick an end date." };
  if (endMs <= startMs) {
    return { ok: false, error: "The end date has to be after the start date." };
  }
  if (endMs <= Date.now()) return { ok: false, error: "The end date is in the past." };

  const targets: DiscountTarget[] = [];
  if (!draft.appliesToAll) {
    for (const g of groups) {
      for (const p of g.packages) {
        if (!draft.selected.has(packageSignature(p))) continue;
        targets.push(p.interval ? { kind: p.kind, key: p.key, interval: p.interval } : {
          kind: p.kind,
          key: p.key,
        });
      }
    }
    if (targets.length === 0) {
      return { ok: false, error: "Pick at least one package, or switch on All packages." };
    }
  }

  return {
    ok: true,
    body: {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      discount_type: draft.discountType,
      percent_off: draft.discountType === "percent" ? num : null,
      amount_off_cents: draft.discountType === "amount" ? draftValueCents(draft) : null,
      starts_at: new Date(startMs).toISOString(),
      ends_at: new Date(endMs).toISOString(),
      applies_to_all: draft.appliesToAll,
      targets,
      enabled: true,
    },
  };
}
