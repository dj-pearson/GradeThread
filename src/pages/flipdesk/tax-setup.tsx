import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Receipt, Save } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ACCOUNTING_METHODS,
  ACCOUNTING_METHOD_HELP,
  ACCOUNTING_METHOD_LABELS,
  ENTITY_TYPES,
  ENTITY_TYPE_HELP,
  ENTITY_TYPE_LABELS,
  FILING_STATUSES,
  FILING_STATUS_LABELS,
  MONTH_LABELS,
  TAX_PROFILE_DEFAULTS,
  US_STATES,
  fetchTaxProfile,
  fetchTaxProfileChanges,
  fiscalYearLabel,
  saveTaxProfile,
  type AccountingMethod,
  type EntityType,
  type FilingStatus,
  centsToDollarInput,
  dollarInputToCents,
  type TaxProfileDefaults,
} from "@/lib/tax-profile";

// US-2982 — the tax setup screen.
//
// Deliberately does no maths and shows no money. It exists so that the P&L, the
// estimated-tax figure, the COGS worksheet and the tax packet stop guessing:
// until now finances.tsx assumed a January year start for everyone, and a
// seller on any other fiscal year was shown the wrong twelve months with no
// indication anything was off.
//
// The form is one column, not a grid of setting cards. Every field here is a
// decision the seller makes once, in order, and a two-column layout would let
// them skip the middle of it.

const FIELD_CLASS = "space-y-1.5";
const HELP_CLASS = "text-[13px] leading-relaxed text-muted-foreground";

export function TaxSetupPage() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [form, setForm] = useState<TaxProfileDefaults>(TAX_PROFILE_DEFAULTS);
  const [otherIncome, setOtherIncome] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: profile, isLoading } = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
  });

  const { data: changes = [] } = useQuery({
    queryKey: ["tax-profile-changes", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfileChanges,
  });

  // Seed the form once the row (or the defaults standing in for it) arrives.
  useEffect(() => {
    if (!profile) return;
    setForm({
      entity_type: profile.entity_type,
      accounting_method: profile.accounting_method,
      fiscal_year_start_month: profile.fiscal_year_start_month,
      filing_state: profile.filing_state,
      filing_status: profile.filing_status,
      business_started_on: profile.business_started_on,
      has_ein: profile.has_ein,
      other_household_income_cents: profile.other_household_income_cents,
    });
    setOtherIncome(centsToDollarInput(profile.other_household_income_cents));
  }, [profile]);

  function set<K extends keyof TaxProfileDefaults>(
    key: K,
    value: TaxProfileDefaults[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    if (!user) return;
    setSaving(true);
    try {
      await saveTaxProfile(user.id, {
        ...form,
        other_household_income_cents: dollarInputToCents(otherIncome),
      });
      await qc.invalidateQueries({ queryKey: ["tax-profile"] });
      await qc.invalidateQueries({ queryKey: ["tax-profile-changes"] });
      // The finances dashboard reads the fiscal year, so a change here has to
      // invalidate it or the seller saves a July year start and the numbers on
      // the next tab still cover January to December.
      await qc.invalidateQueries({ queryKey: ["finances-dashboard"] });
      toast.success("Tax setup saved.");
    } catch (err) {
      toastError(err, "Couldn't save your tax setup.");
    } finally {
      setSaving(false);
    }
  }

  const now = new Date();
  const yearLabel = fiscalYearLabel(now, form.fiscal_year_start_month);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Receipt}
        title="Tax setup"
        subtitle="Five answers. Everything else in Money reads them, so the numbers match what you actually file."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How you sell</CardTitle>
        </CardHeader>
        <CardContent className="max-w-2xl space-y-6">
          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-entity">Business type</Label>
            <Select
              value={form.entity_type}
              onValueChange={(v) => set("entity_type", v as EntityType)}
            >
              <SelectTrigger id="tax-entity" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ENTITY_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className={HELP_CLASS}>{ENTITY_TYPE_HELP[form.entity_type]}</p>
          </div>

          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-method">When money counts</Label>
            <Select
              value={form.accounting_method}
              onValueChange={(v) =>
                set("accounting_method", v as AccountingMethod)
              }
            >
              <SelectTrigger id="tax-method" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNTING_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {ACCOUNTING_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className={HELP_CLASS}>
              {ACCOUNTING_METHOD_HELP[form.accounting_method]}
            </p>
            {profile &&
              "accounting_method" in profile &&
              profile.accounting_method !== form.accounting_method && (
                <p className="text-[13px] leading-relaxed text-amber-700 dark:text-amber-400">
                  Changing this moves which year some sales land in. We record
                  the change and the date, so you can explain it later.
                </p>
              )}
          </div>

          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-fy">Tax year starts in</Label>
            <Select
              value={String(form.fiscal_year_start_month)}
              onValueChange={(v) =>
                set("fiscal_year_start_month", Number(v))
              }
            >
              <SelectTrigger id="tax-fy" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTH_LABELS.map((label, i) => (
                  <SelectItem key={label} value={String(i + 1)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className={HELP_CLASS}>
              {form.fiscal_year_start_month === 1
                ? "January to December, like almost everyone. Your current tax year is " +
                  yearLabel +
                  "."
                : "Your current tax year is " +
                  yearLabel +
                  ". Every total in Money uses those twelve months, not January to December."}
            </p>
          </div>

          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-started">Started selling</Label>
            <Input
              id="tax-started"
              type="date"
              className="w-full sm:w-56"
              value={form.business_started_on ?? ""}
              onChange={(e) =>
                set("business_started_on", e.target.value || null)
              }
            />
            <p className={HELP_CLASS}>
              Optional. Used to work out your first part-year totals.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How you file</CardTitle>
        </CardHeader>
        <CardContent className="max-w-2xl space-y-6">
          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-status">Filing status</Label>
            <Select
              value={form.filing_status}
              onValueChange={(v) => set("filing_status", v as FilingStatus)}
            >
              <SelectTrigger id="tax-status" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILING_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {FILING_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-state">State</Label>
            <Select
              value={form.filing_state ?? "none"}
              onValueChange={(v) =>
                set("filing_state", v === "none" ? null : v)
              }
            >
              <SelectTrigger id="tax-state" className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not set</SelectItem>
                {US_STATES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-other-income">Other household income</Label>
            <Input
              id="tax-other-income"
              inputMode="decimal"
              placeholder="0.00"
              className="w-full sm:w-56"
              value={otherIncome}
              onChange={(e) => setOtherIncome(e.target.value)}
            />
            <p className={HELP_CLASS}>
              Optional. A job, a spouse's wages, anything outside reselling.
              Without it, the set-aside figure assumes reselling is all you earn
              and comes out low.
            </p>
          </div>

          <div className={FIELD_CLASS}>
            <Label htmlFor="tax-ein">Do you have an EIN?</Label>
            <Select
              value={form.has_ein ? "yes" : "no"}
              onValueChange={(v) => set("has_ein", v === "yes")}
            >
              <SelectTrigger id="tax-ein" className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">No</SelectItem>
                <SelectItem value="yes">Yes</SelectItem>
              </SelectContent>
            </Select>
            <p className={HELP_CLASS}>
              We never ask for the number and never store it. This only puts a
              line on your year-end packet reminding you to fill it in.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving || !user}>
          <Save className="mr-2 h-4 w-4" />
          {saving ? "Saving" : "Save tax setup"}
        </Button>
        <p className="text-[13px] text-muted-foreground">
          GradeThread does the arithmetic. It does not give tax advice.
        </p>
      </div>

      {changes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What you changed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-[13px] leading-relaxed text-muted-foreground">
              Business type, accounting method and tax year are choices you make
              to the IRS, not preferences. We keep the dates so a past year's
              numbers can be explained.
            </p>
            <ul className="space-y-2 text-sm">
              {changes.map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground">
                    {new Date(c.changed_at).toLocaleDateString()}
                  </span>
                  <span>{c.field.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">
                    {c.old_value} to {c.new_value}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
