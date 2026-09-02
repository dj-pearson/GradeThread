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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import { BadgeCheck, ShieldCheck } from "lucide-react";

interface CreatorStatus {
  program: "user" | "creator";
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

export function CreatorProgramme() {
  const queryClient = useQueryClient();
  const [legalName, setLegalName] = useState("");
  const [entityType, setEntityType] = useState("individual");
  const [tin, setTin] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");

  const { data, isLoading } = useQuery<CreatorStatus>({
    queryKey: ["affiliate-creator"],
    queryFn: async () => {
      const res = await edgeFetch("/api/affiliate/creator");
      const json = await res.json();
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
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't record that");
      return json as { pending_approval: boolean };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["affiliate-creator"] });
      toast.success(
        result.pending_approval
          ? "Application in. We review creators one at a time and will email you."
          : "Terms accepted.",
      );
    },
    onError: (err) => toastError(err, "Couldn't record that"),
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
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Couldn't save your tax details");
      return json as { last4: string };
    },
    onSuccess: () => {
      // Clear the number from the page as soon as it is stored. Nothing on this
      // screen needs it again, and a form left populated is a number sitting in
      // a tab someone walks away from.
      setTin("");
      void queryClient.invalidateQueries({ queryKey: ["affiliate-creator"] });
      toast.success("Tax details saved.");
    },
    onError: (err) => toastError(err, "Couldn't save your tax details"),
  });

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const isCreator = data.program === "creator";
  const applied = Boolean(data.accepted_at);
  const tinDigits = tin.replace(/\D/g, "");
  const canSaveTax = legalName.trim().length > 1 && tinDigits.length === 9 &&
    !saveTax.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BadgeCheck className="h-5 w-5 text-brand-red-text" /> Creator programme
          </CardTitle>
          <CardDescription>
            Cash commission for creators who bring paying sellers to FlipDesk. This is
            separate from the referral link above, which earns grade credits.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                {CREATOR_AFFILIATE.commissionPct}% of subscription revenue
              </span>{" "}
              from each account you refer, for {CREATOR_AFFILIATE.windowMonths} months,
              up to ${CREATOR_AFFILIATE.capUsd} per account.
            </li>
            <li>
              Paid monthly by Stripe, {CREATOR_AFFILIATE.holdDays} days after each
              invoice clears.
            </li>
            <li>
              Read the full terms on the{" "}
              <a href="/partners" className="font-medium underline">
                partners page
              </a>
              .
            </li>
          </ul>

          {isCreator ? (
            <p className="rounded-md bg-muted p-3 text-sm">
              You're in the creator programme. Your earnings show in the payout card
              on this page.
            </p>
          ) : applied ? (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              Your application is in. We admit creators one at a time and will email
              you either way. Nothing is earned until then.
            </p>
          ) : null}

          {(!applied || !data.terms_current) && (
            <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {applied
                  ? "The terms changed since you agreed. Read them and accept the current version."
                  : "Accepting the terms applies to the programme. It does not admit you to it."}
              </p>
              <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
                {accept.isPending ? "Sending…" : "Accept and apply"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-brand-red-text" /> Tax details
          </CardTitle>
          <CardDescription>
            No cash moves until this is on file. US creators paid $600 or more in a
            year get a 1099.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.tax_profile.certified && (
            <p className="rounded-md bg-muted p-3 text-sm">
              On file for {data.tax_profile.legal_name}, tax ID ending{" "}
              <span className="font-mono">{data.tax_profile.last4}</span>. Filling
              the form in again replaces it.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="creator-legal-name" className="text-xs font-medium text-muted-foreground">
                Legal name
              </label>
              <Input
                id="creator-legal-name"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value.slice(0, 200))}
                placeholder="As it appears on your tax return"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="creator-entity-type" className="text-xs font-medium text-muted-foreground">
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
              <label htmlFor="creator-tin" className="text-xs font-medium text-muted-foreground">
                Tax ID (SSN or EIN)
              </label>
              <Input
                id="creator-tin"
                value={tin}
                inputMode="numeric"
                autoComplete="off"
                onChange={(e) => setTin(e.target.value.slice(0, 11))}
                placeholder="9 digits"
              />
              <p className="text-xs text-muted-foreground">
                Encrypted before it is stored. Only the last four digits are readable
                afterwards, including by us.
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="creator-address" className="text-xs font-medium text-muted-foreground">
                Street address
              </label>
              <Input
                id="creator-address"
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value.slice(0, 200))}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="creator-city" className="text-xs font-medium text-muted-foreground">
                City
              </label>
              <Input
                id="creator-city"
                value={city}
                onChange={(e) => setCity(e.target.value.slice(0, 100))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="creator-region" className="text-xs font-medium text-muted-foreground">
                  State
                </label>
                <Input
                  id="creator-region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value.slice(0, 100))}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="creator-postal" className="text-xs font-medium text-muted-foreground">
                  ZIP
                </label>
                <Input
                  id="creator-postal"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value.slice(0, 20))}
                />
              </div>
            </div>
          </div>

          <Button onClick={() => saveTax.mutate()} disabled={!canSaveTax}>
            {saveTax.isPending ? "Saving…" : "Save tax details"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
