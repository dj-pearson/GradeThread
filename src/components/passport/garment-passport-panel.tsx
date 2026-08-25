import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  Stamp,
  ExternalLink,
  ShieldCheck,
  BadgeCheck,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { track } from "@/lib/analytics";
import { PassportTagPanel } from "@/components/passport/passport-tag-panel";
import { PassportClaimLinkPanel } from "@/components/passport/passport-claim-link-panel";
import type { GarmentRow } from "@/types/database";

// US-1120: turn a fresh grade into a Garment Passport conversion surface.
//
// Previously the seller only ever saw the physical-tag generator, and only when
// the grade already had a passport (garment_id set). This panel makes the
// passport itself the headline once a grade lands:
//   • garment_id present → "Your Garment Passport" with a prominent View link
//     (resolved to the public slug) + the physical-tag generator below it;
//   • garment_id absent (legacy grades that pre-date auto-passports) → a
//     "Create a Garment Passport" path that explains the feature and points to
//     grading an item to start one.
// Both states carry the verified-seller + buyer-guarantee trust hints so the
// surface connects to the rest of the trust ecosystem. No PII is rendered — the
// slug is the only garment identifier shown, and it drives a public, PII-free page.

interface GarmentPassportPanelProps {
  /** The garment this grade is linked to, or null when it has no passport yet. */
  garmentId: string | null;
  /** Owning submission — attached to conversion events for attribution. */
  submissionId: string;
}

export function GarmentPassportPanel({
  garmentId,
  submissionId,
}: GarmentPassportPanelProps) {
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!garmentId) {
      setSlug(null);
      return;
    }
    let cancelled = false;
    (async () => {
      // RLS scopes `garments` to created_by = auth.uid(), so this only ever
      // resolves a passport the viewer owns.
      const { data } = await supabase
        .from("garments")
        .select("public_passport_slug")
        .eq("id", garmentId)
        .maybeSingle();
      const row =
        (data ?? null) as unknown as Pick<GarmentRow, "public_passport_slug"> | null;
      if (!cancelled) setSlug(row?.public_passport_slug ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [garmentId]);

  // Legacy grade with no passport: introduce the feature + a create path.
  if (!garmentId) {
    return (
      <Card className="border-brand-navy/30 bg-brand-navy/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Stamp className="h-5 w-5 text-brand-navy dark:text-foreground" />
            Create a Garment Passport
          </CardTitle>
          <CardDescription>
            Every grade gives the item a public Passport: a page you can share
            showing its grades, listings, sales and owners in order. It stays
            with the garment when you sell it, which is what buyers trust.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild>
            <Link
              to="/dashboard/submissions/new"
              onClick={() =>
                track("passport_create_cta_clicked", {
                  submission_id: submissionId,
                  source: "submission-detail",
                })
              }
            >
              Grade an item to start a passport
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
          <PassportTrustHints />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="border-brand-navy/30 bg-brand-navy/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Stamp className="h-5 w-5 text-brand-navy dark:text-foreground" />
            Your Garment Passport
          </CardTitle>
          <CardDescription>
            This grade created a public, confidence-scored provenance passport for the
            item. Share it to prove condition and history — it travels with the
            garment, and the buyer guarantee transfers when the next owner claims it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {slug ? (
            <Button asChild>
              <Link
                to={`/passport/${slug}`}
                onClick={() =>
                  track("passport_view_cta_clicked", {
                    submission_id: submissionId,
                    source: "submission-detail",
                  })
                }
              >
                View this item&rsquo;s passport
                <ExternalLink className="ml-1.5 h-4 w-4" />
              </Link>
            </Button>
          ) : (
            <Button disabled>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading passport&hellip;
            </Button>
          )}
          <PassportTrustHints />
        </CardContent>
      </Card>
      {/* US-2494: the two owner handoffs sit together. The reusable tag is for a
          hand-off in person, the single-use link for a garment that ships. */}
      <PassportTagPanel garmentId={garmentId} />
      <PassportClaimLinkPanel garmentId={garmentId} />
    </div>
  );
}

// Verified-seller + buyer-guarantee hints — the two trust signals that travel
// with a passport. Shared by both panel states.
function PassportTrustHints() {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Link
        to="/dashboard/flipdesk/verified"
        className="flex items-start gap-2 rounded-md border bg-background p-3 text-sm transition-colors hover:border-brand-navy/40"
      >
        <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy dark:text-foreground" />
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">Become a Verified Seller</span>{" "}
          — attach your public, grade-backed trust badge to every passport.
        </span>
      </Link>
      <Link
        to="/buyer-guarantee"
        className="flex items-start gap-2 rounded-md border bg-background p-3 text-sm transition-colors hover:border-brand-navy/40"
      >
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-navy dark:text-foreground" />
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">Buyer guarantee</span> —
          passported items are condition-backed and easier to resell.
        </span>
      </Link>
    </div>
  );
}
