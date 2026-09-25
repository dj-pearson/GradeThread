// US-9212: the creator programme panel.
//
// Two things happen here and nowhere else: a creator accepts the programme's
// own terms, and files the tax form that lets cash move at all. Both are
// deliberately separate from the referral tab next to it, because they are a
// different arrangement -- a seller sharing a link earns grade credits and is
// never asked for a tax ID.
//
// The panel never claims someone is in the programme. Accepting the terms is an
// application; the copy says so, and the server keeps `program` at "user" until
// an operator admits them.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { edgeFetch } from "@/lib/edge-fetch";
import { CREATOR_AFFILIATE } from "@/lib/constants";
import { US_STATES } from "@/lib/tax-profile";
import { taxFormErrors, type TaxField } from "@/lib/referral-page";
import { BadgeCheck, Eye, EyeOff, Lock, ShieldCheck } from "lucide-react";

interface CreatorAccountRow {
  ref: string;
  earned: number;
  cap_remaining: number;
  first_earned_at: string | null;
  window_ends_at: string | null;
}

interface CreatorStatus {
  program: "user" | "creator";
  code: string;
  commission_pct: number;
  // The live config. Older edges did not send these; the constants are the
  // fallback so the copy never reads "undefined".
  cap_usd?: number;
  window_months?: number;
  hold_days?: number;
  earnings: {
    clicks: number;
    signups: number;
    owed: number;
    payable: number;
    held: number;
    paid: number;
    accounts: CreatorAccountRow[];
  };
  terms_version: string;
  accepted_version: string | null;
  accepted_at: string | null;
  terms_current: boolean;
  approved_at: string | null;
  tax_profile: {
    certified: boolean;
    certified_at: string | null;
    legal_name: string | null;
    entity_type: string | null;
    last4: string | null;
  };
}

const ENTITY_TYPES: Array<{ value: string; label: string }> = [
  { value: "individual", label: "Individual" },
  { value: "sole_proprietor", label: "Sole proprietor" },
  { value: "single_member_llc", label: "Single-member LLC" },
  { value: "c_corp", label: "C corporation" },
  { value: "s_corp", label: "S corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "trust", label: "Trust or estate" },
  { value: "other", label: "Something else" },
];

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

export function CreatorProgramme({ onOpenAffiliate }: { onOpenAffiliate?: () => void } = {}) {
  const queryClient = useQueryClient();
  const [legalName, setLegalName] = useState("");
  const [entityType, setEntityType] = useState("individual");
  const [tin, setTin] = useState("");
  const [showTin, setShowTin] = useState(false);
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [certify, setCertify] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [readTerms, setReadTerms] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<CreatorStatus>({
    queryKey: ["affiliate-creator"],
    queryFn: async () => {
      const res = await edgeFetch("/api/affiliate/creator");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load your creator status");
      return json as CreatorStatus;
    },
  });

  const accept = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch("/api/affiliate/creator/terms", {
        method: "POST",
        body: JSON.stringify({ accept: true, version: data?.terms_version }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(json.error || "Couldn't record that", res.status);
      return json as { pending_approval: boolean };
    },
    onSuccess: (result) => {
      setReadTerms(false);
      void queryClient.invalidateQueries({ queryKey: ["affiliate-creator"] });
      toast.success(
        result.pending_approval
          ? "Application in. We review creators one at a time and will email you."
          : "Terms accepted.",
      );
    },
    onError: (err) => {
      // 409: the terms changed under us. Reload them so the next click agrees
      // to the text actually on the page.
      if (err instanceof HttpError && err.status === 409) {
        setReadTerms(false);
        void queryClient.invalidateQueries({ queryKey: ["affiliate-creator"] });
      }
      toastError(err, "Couldn't record that");
    },
  });

  const saveTax = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch("/api/affiliate/tax-profile", {
        method: "POST",
        body: JSON.stringify({
          legal_name: legalName,
          entity_type: entityType,
          tin,
          address_line1: addressLine1,
          city,
          region,
          postal_code: postalCode,
          country: "US",
          certify: true,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't save your tax details");
      return json as { last4: string };
    },
    onSuccess: () => {
      // Clear the number from the page as soon as it is stored. Nothing on this
      // screen needs it again, and a form left populated is a number sitting in
      // a tab someone walks away from.
      setTin("");
      setShowTin(false);
      setCertify(false);
      setSubmitted(false);
      setReplacing(false);
      void queryClient.invalidateQueries({ queryKey: ["affiliate-creator"] });
      toast.success("Tax details saved.");
    },
    onError: (err) => toastError(err, "Couldn't save your tax details"),
  });

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load the creator program"
        onRetry={() => refetch()}
        retrying={isFetching}
      />
    );
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const isCreator = data.program === "creator";
  const applied = Boolean(data.accepted_at);
  const pct = data.commission_pct ?? CREATOR_AFFILIATE.commissionPct;
  const capUsd = data.cap_usd ?? CREATOR_AFFILIATE.capUsd;
  const windowMonths = data.window_months ?? CREATOR_AFFILIATE.windowMonths;
  const holdDays = data.hold_days ?? CREATOR_AFFILIATE.holdDays;

  // The SSN field exists only for someone we would actually pay: admitted, on
  // the current terms. Everyone else sees one locked line.
  const taxFormOpen = isCreator && data.terms_current;
  const showTaxForm = taxFormOpen && (!data.tax_profile.certified || replacing);

  const errors = taxFormErrors({ legalName, tin, addressLine1, city, region, postalCode, certify });
  const shownErrors = submitted ? errors : {};
  const invalid = (f: TaxField) => (shownErrors[f] ? true : undefined);
  const describedBy = (f: TaxField) => (shownErrors[f] ? `creator-${f}-error` : undefined);

  const submitTax = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0 || saveTax.isPending) return;
    saveTax.mutate();
  };

  const startReplace = () => {
    setLegalName(data.tax_profile.legal_name ?? "");
    if (data.tax_profile.entity_type) setEntityType(data.tax_profile.entity_type);
    setReplacing(true);
  };

  const affiliateButton = onOpenAffiliate ? (
    <Button type="button" variant="link" className="h-auto p-0" onClick={onOpenAffiliate}>
      Affiliate tab
    </Button>
  ) : (
    "Affiliate tab"
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BadgeCheck className="h-5 w-5 text-brand-red-text" /> Creator program
          </CardTitle>
          <CardDescription>
            Cash commission for creators who bring paying sellers to FlipDesk. This is
            separate from your referral link on the Share tab, which earns grade credits.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                {pct}% of subscription revenue
              </span>{" "}
              from each account you refer, for {windowMonths} months, up to{" "}
              {usd(capUsd)} per account.
            </li>
            <li>Paid by Stripe, {holdDays} days after each invoice clears.</li>
            <li>
              Read the full terms on the{" "}
              <a
                href="/partners"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline"
              >
                partners page
              </a>{" "}
              (opens in a new tab).
            </li>
          </ul>

          {isCreator ? (
            <p className="rounded-md bg-muted p-3 text-sm">
              You're in the creator program. Your balance and payouts are on the{" "}
              {affiliateButton}.
            </p>
          ) : applied ? (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              Your application is in. We admit creators one at a time and will email
              you either way. Nothing is earned until then.
            </p>
          ) : null}

          {(!applied || !data.terms_current) && (
            <div className="space-y-3 rounded-md border border-dashed p-3">
              <p className="text-sm text-muted-foreground">
                {applied
                  ? "The terms changed since you agreed. Read them and accept the current version."
                  : "Accepting the terms applies to the program. It does not admit you to it."}
              </p>
              <div className="flex items-start gap-2 text-sm">
                <Checkbox
                  id="creator-read-terms"
                  checked={readTerms}
                  onCheckedChange={(v) => setReadTerms(v === true)}
                  className="mt-0.5"
                />
                <label htmlFor="creator-read-terms">
                  I have read the creator terms (version {data.terms_version}).
                </label>
              </div>
              <Button onClick={() => accept.mutate()} disabled={!readTerms || accept.isPending}>
                {accept.isPending ? "Sending..." : "Accept and apply"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* AC6: clicks, signups, paid and owed. Shown to anyone who opens the
          tab, because zeros are the honest answer before admission rather than
          a hidden card that implies something is being withheld. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your numbers</CardTitle>
          <CardDescription>
            Clicks and signups on your link, and what the commission ledger says you
            are owed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Clicks", value: String(data.earnings.clicks) },
              { label: "Signups", value: String(data.earnings.signups) },
              { label: "Owed", value: usd(data.earnings.owed) },
              { label: "Paid", value: usd(data.earnings.paid) },
            ].map((stat) => (
              <div key={stat.label} className="rounded-md bg-muted p-3">
                <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
                <div className="text-xs text-muted-foreground">{stat.label}</div>
              </div>
            ))}
          </div>
          {data.earnings.owed > 0 && (
            <p className="text-sm text-muted-foreground">
              {usd(data.earnings.payable)} of that is past its hold and would go in the
              next payout run; {usd(data.earnings.held)} is still holding.
            </p>
          )}

          {data.earnings.accounts.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Per referred account. We show what each one earned you and when its
                window closes, never who they are.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1 pr-4 font-medium">Account</th>
                      <th className="py-1 pr-4 font-medium">Earned</th>
                      <th className="py-1 pr-4 font-medium">Cap left</th>
                      <th className="py-1 font-medium">Window ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.earnings.accounts.map((row) => (
                      <tr key={row.ref} className="border-t">
                        <td className="py-1.5 pr-4 font-mono text-xs">{row.ref}</td>
                        <td className="py-1.5 pr-4 tabular-nums">{usd(row.earned)}</td>
                        <td className="py-1.5 pr-4 tabular-nums">{usd(row.cap_remaining)}</td>
                        <td className="py-1.5 text-muted-foreground">
                          {row.window_ends_at
                            ? new Date(row.window_ends_at).toLocaleDateString()
                            : "Not started"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No commission yet. A referred account earns you {pct}% of each invoice it
              pays, starting from its first one.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-brand-red-text" /> Tax details
          </CardTitle>
          <CardDescription>
            No cash moves until this is on file. US creators paid $2,000 or more in a
            year get a 1099.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!taxFormOpen ? (
            <p className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground">
              <Lock className="h-4 w-4 shrink-0" aria-hidden />
              Once we admit you, we'll ask for tax details here.
            </p>
          ) : (
            <>
              {data.tax_profile.certified && (
                <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <p>
                    On file for {data.tax_profile.legal_name}, tax ID ending{" "}
                    <span className="font-mono">{data.tax_profile.last4}</span>.
                  </p>
                  {!replacing && (
                    <Button type="button" variant="outline" size="sm" onClick={startReplace}>
                      Replace tax details
                    </Button>
                  )}
                </div>
              )}

              {showTaxForm && (
                <form onSubmit={submitTax} noValidate className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label htmlFor="creator-legal-name" className="text-sm font-medium">
                        Legal name
                      </label>
                      <Input
                        id="creator-legal-name"
                        value={legalName}
                        required
                        aria-invalid={invalid("legal_name")}
                        aria-describedby={describedBy("legal_name")}
                        onChange={(e) => setLegalName(e.target.value.slice(0, 200))}
                        placeholder="As it appears on your tax return"
                      />
                      <FieldError id="creator-legal_name-error" message={shownErrors.legal_name} />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="creator-entity-type" className="text-sm font-medium">
                        How you file
                      </label>
                      <Select value={entityType} onValueChange={setEntityType}>
                        <SelectTrigger id="creator-entity-type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ENTITY_TYPES.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <label htmlFor="creator-tin" className="text-sm font-medium">
                        Tax ID (SSN or EIN)
                      </label>
                      <div className="flex gap-2">
                        <Input
                          id="creator-tin"
                          type={showTin ? "text" : "password"}
                          value={tin}
                          required
                          inputMode="numeric"
                          autoComplete="off"
                          data-sentry-mask
                          className="ph-no-capture"
                          aria-invalid={invalid("tin")}
                          aria-describedby={[describedBy("tin"), "creator-tin-help"].filter(Boolean).join(" ")}
                          onChange={(e) => setTin(e.target.value.slice(0, 11))}
                          placeholder="9 digits"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          aria-pressed={showTin}
                          onClick={() => setShowTin((v) => !v)}
                        >
                          {showTin ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                          {showTin ? "Hide" : "Show"}
                        </Button>
                      </div>
                      <FieldError id="creator-tin-error" message={shownErrors.tin} />
                      <p id="creator-tin-help" className="text-xs text-muted-foreground">
                        Encrypted before it is stored. Only the last four digits are readable
                        afterwards, including by us.
                      </p>
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <label htmlFor="creator-address" className="text-sm font-medium">
                        Street address
                      </label>
                      <Input
                        id="creator-address"
                        value={addressLine1}
                        required
                        autoComplete="address-line1"
                        aria-invalid={invalid("address_line1")}
                        aria-describedby={describedBy("address_line1")}
                        onChange={(e) => setAddressLine1(e.target.value.slice(0, 200))}
                      />
                      <FieldError id="creator-address_line1-error" message={shownErrors.address_line1} />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="creator-city" className="text-sm font-medium">
                        City
                      </label>
                      <Input
                        id="creator-city"
                        value={city}
                        required
                        autoComplete="address-level2"
                        aria-invalid={invalid("city")}
                        aria-describedby={describedBy("city")}
                        onChange={(e) => setCity(e.target.value.slice(0, 100))}
                      />
                      <FieldError id="creator-city-error" message={shownErrors.city} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label htmlFor="creator-region" className="text-sm font-medium">
                          State
                        </label>
                        <Select value={region} onValueChange={setRegion}>
                          <SelectTrigger
                            id="creator-region"
                            aria-invalid={invalid("region")}
                            aria-describedby={describedBy("region")}
                          >
                            <SelectValue placeholder="State" />
                          </SelectTrigger>
                          <SelectContent>
                            {US_STATES.map((st) => (
                              <SelectItem key={st} value={st}>
                                {st}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FieldError id="creator-region-error" message={shownErrors.region} />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="creator-postal" className="text-sm font-medium">
                          ZIP
                        </label>
                        <Input
                          id="creator-postal"
                          value={postalCode}
                          required
                          inputMode="numeric"
                          autoComplete="postal-code"
                          aria-invalid={invalid("postal_code")}
                          aria-describedby={describedBy("postal_code")}
                          onChange={(e) => setPostalCode(e.target.value.slice(0, 10))}
                        />
                        <FieldError id="creator-postal_code-error" message={shownErrors.postal_code} />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5 rounded-md border p-3">
                    <div className="flex items-start gap-2 text-sm">
                      <Checkbox
                        id="creator-certify"
                        checked={certify}
                        onCheckedChange={(v) => setCertify(v === true)}
                        aria-invalid={invalid("certify")}
                        aria-describedby={describedBy("certify")}
                        className="mt-0.5"
                      />
                      <label htmlFor="creator-certify">
                        I certify that the tax ID above is correct and is mine, that I am
                        a US person (a US citizen or US resident), and that I am not
                        subject to backup withholding. This takes the place of a W-9.
                      </label>
                    </div>
                    <FieldError id="creator-certify-error" message={shownErrors.certify} />
                  </div>

                  <div className="flex gap-2">
                    <Button type="submit" disabled={saveTax.isPending}>
                      {saveTax.isPending ? "Saving..." : "Certify and save"}
                    </Button>
                    {replacing && (
                      <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </form>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
