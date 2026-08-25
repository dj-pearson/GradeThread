import { lazy, Suspense } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { ScoreBandIcon } from "@/components/grade/score-indicator";
import { PwaInstallBanner } from "@/components/flipdesk/pwa-install-banner";
import { supabase } from "@/lib/supabase";
import { fetchInChunks } from "@/lib/supabase-batch";
import {
  FLIPDESK_PLANS,
  flipdeskPlanForLegacy,
  getScoreColor,
  getStatusBadgeClasses,
  type PlanKey,
} from "@/lib/constants";
import type {
  SubmissionRow,
  GradeReportRow,
  InventoryItemRow,
  ListingRow,
  GarmentRow,
  UserUseCase,
} from "@/types/database";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileText,
  TrendingUp,
  Plus,
  KeyRound,
  Package,
  DollarSign,
  ScanLine,
  ShieldCheck,
  Shield,
  BadgeCheck,
  Stamp,
  Handshake,
  Code,
  ArrowRight,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ChartSkeleton } from "@/components/ui/skeletons";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

// Defer the Recharts bundle so the dashboard shell paints before charts load.
const GradeCharts = lazy(() =>
  import("@/components/dashboard/grade-charts").then((m) => ({
    default: m.GradeCharts,
  })),
);
import { ListingSuggestions } from "@/components/analytics/listing-suggestions";
import { ActivationChecklist } from "@/components/onboarding/activation-checklist";
import { FlipdeskPromoCard } from "@/components/flipdesk/flipdesk-promo-card";
import { InviteFriendCard } from "@/components/referral/invite-friend-card";
import { ImpactTile } from "@/components/impact/impact-tile";
import { RewardsWidget } from "@/components/rewards/rewards-widget";
import { UsageMeters } from "@/components/billing/usage-meter";

// US-2204: the recent-submissions list renders four columns. Typing the rows as
// the projection (not SubmissionRow) makes a dropped column a tsc error instead
// of a blank cell.
type RecentSubmissionRow = Pick<
  SubmissionRow,
  "id" | "title" | "status" | "created_at"
>;
const RECENT_SUBMISSION_COLUMNS = "id, title, status, created_at";

interface RecentSubmission extends RecentSubmissionRow {
  grade_report?: Pick<GradeReportRow, "overall_score" | "grade_tier"> | null;
}

function formatLabel(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ─── Persona-aware dashboard config (US-1118) ──────────────────────────
// The authenticated dashboard tailors its quick actions, feature entry
// points, and zero-data first-run CTA to the user's onboarding `use_case`
// (seller / buyer / consignment / developer) instead of showing three
// unconditional reseller cards to everyone.

interface QuickAction {
  key: string;
  icon: LucideIcon;
  label: string;
  sublabel: string;
  to: string;
}

interface FeatureCard {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  to: string;
  cta: string;
}

interface FeatureContext {
  verifiedEnabled: boolean;
  verifiedHandle: string | null;
  passportCount: number;
  latestPassportSlug: string | null;
}

interface FirstRunHint {
  icon: LucideIcon;
  title: string;
  description: string;
  cta: string;
  to: string;
}

function quickActionsFor(useCase: UserUseCase | null): QuickAction[] {
  switch (useCase) {
    case "buyer":
      return [
        { key: "scan", icon: ScanLine, label: "Scan a Passport", sublabel: "Check an item before you buy", to: "/scan" },
        { key: "verify", icon: ShieldCheck, label: "Verify a Certificate", sublabel: "Confirm a grade is authentic", to: "/verify" },
        { key: "verified", icon: BadgeCheck, label: "Verified Sellers", sublabel: "Browse trusted sellers", to: "/verified" },
      ];
    case "developer":
      return [
        { key: "keys", icon: KeyRound, label: "API Keys", sublabel: "Create & manage keys", to: "/dashboard/account?tab=api-keys" },
        { key: "docs", icon: Code, label: "API Docs", sublabel: "Integrate grading", to: "/developers" },
        { key: "new", icon: Plus, label: "New Submission", sublabel: "Grade a garment", to: "/dashboard/submissions/new" },
      ];
    case "consignment":
      return [
        { key: "new", icon: Plus, label: "New Submission", sublabel: "Grade a garment", to: "/dashboard/submissions/new" },
        { key: "consign", icon: Handshake, label: "Consignment", sublabel: "Consignors & payouts", to: "/dashboard/flipdesk/consignment" },
        { key: "finances", icon: DollarSign, label: "View Finances", sublabel: "Profit & payouts", to: "/dashboard/flipdesk/money?view=finances" },
      ];
    case "seller":
    default:
      return [
        { key: "new", icon: Plus, label: "New Submission", sublabel: "Grade a garment", to: "/dashboard/submissions/new" },
        // US-2537: was /dashboard/inventory/new, which is a <Navigate> redirect
        // to this path — one extra hop on the most-clicked quick action.
        { key: "inventory", icon: Package, label: "Add Inventory Item", sublabel: "Track a new item", to: "/dashboard/flipdesk/intake" },
        { key: "finances", icon: DollarSign, label: "View Finances", sublabel: "Profit & analytics", to: "/dashboard/flipdesk/money?view=finances" },
      ];
  }
}

function featureCardsFor(useCase: UserUseCase | null, ctx: FeatureContext): FeatureCard[] {
  const verified: FeatureCard = ctx.verifiedEnabled
    ? {
        key: "verified",
        icon: BadgeCheck,
        title: "Verified Seller profile",
        description: ctx.verifiedHandle
          ? `Your public trust profile is live — @${ctx.verifiedHandle}.`
          : "Your public trust profile is live.",
        to: "/dashboard/flipdesk/verified",
        cta: "Manage profile",
      }
    : {
        key: "verified",
        icon: BadgeCheck,
        title: "Become a Verified Seller",
        description: "Build buyer trust with a public, grade-backed seller profile.",
        to: "/dashboard/flipdesk/verified",
        cta: "Set up",
      };

  const passport: FeatureCard = ctx.passportCount > 0 && ctx.latestPassportSlug
    ? {
        key: "passport",
        icon: Stamp,
        title: "Garment Passports",
        description: `${ctx.passportCount} ${ctx.passportCount === 1 ? "passport" : "passports"} created — view a verified provenance timeline.`,
        to: `/passport/${ctx.latestPassportSlug}`,
        cta: "View latest",
      }
    : {
        key: "passport",
        icon: Stamp,
        title: "Garment Passports",
        description: "Every grade creates a public provenance passport for the item.",
        to: "/dashboard/submissions/new",
        cta: "Grade an item",
      };

  const guarantee: FeatureCard = {
    key: "guarantee",
    icon: Shield,
    title: "Buyer Guarantee",
    description: "Grade-accuracy protection that travels with every item you list.",
    to: "/buyer-guarantee",
    cta: "Learn more",
  };

  const buyerGuarantee: FeatureCard = {
    key: "guarantee",
    icon: Shield,
    title: "Buyer Guarantee",
    description: "Every GradeThread-graded purchase is backed by our accuracy guarantee.",
    to: "/buyer-guarantee",
    cta: "See coverage",
  };

  switch (useCase) {
    case "buyer":
      return [buyerGuarantee];
    case "developer":
      return [passport];
    case "consignment":
    case "seller":
    default:
      return [verified, passport, guarantee];
  }
}

function firstRunFor(useCase: UserUseCase | null): FirstRunHint {
  switch (useCase) {
    case "buyer":
      return {
        icon: ScanLine,
        title: "Scan before you buy",
        description: "Check the verified condition and provenance of any GradeThread-graded item before you purchase it.",
        cta: "Scan a Passport",
        to: "/scan",
      };
    case "developer":
      return {
        icon: KeyRound,
        title: "Integrate condition grading",
        description: "Create an API key and start grading garments programmatically from your own app.",
        cta: "Create an API key",
        // US-2858: the Developers page, not the Account hub tab (US-2554).
        to: "/dashboard/developers",
      };
    case "consignment":
      return {
        icon: Handshake,
        title: "Take in your first consignment",
        description: "Grade and catalog an item, then track payouts to your consignors automatically.",
        cta: "Grade an item",
        to: "/dashboard/submissions/new",
      };
    case "seller":
    default:
      return {
        icon: Plus,
        title: "Grade your first garment",
        description: "Upload a few photos to get an AI-powered condition grade you can list with confidence.",
        cta: "New Submission",
        to: "/dashboard/submissions/new",
      };
  }
}

export function DashboardPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();

  const plan = profile?.plan ?? "free";
  // US-2365: the legacy shim's `gradesPerMonth` was
  // FLIPDESK_PLANS.includedStandardGradesPerMonth under an older name. Read it
  // directly, and prefer the current column where the profile carries one.
  const planConfig = FLIPDESK_PLANS[
    profile?.flipdesk_plan ?? flipdeskPlanForLegacy(plan as PlanKey)
  ];
  // US-2537: the grades-used figure and its percentage lived here to feed a
  // hand-built card that showed the same number the shared usage meters do. They
  // own it now — including the division this code got wrong: a plan whose
  // includedStandardGradesPerMonth is 0 (Free) made `used / 0` = Infinity, and
  // Math.round(Infinity * 100) rendered as "Infinity%" on a new account's very
  // first visit. UsageMeter pins pct to 0 when the limit is 0 or unlimited.

  const {
    data: submissionData,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["dashboard-submissions", profile?.id],
    queryFn: async () => {
      // Fetch total submission count (US-949: exclude superseded retakes — they
      // are history, not active submissions).
      const { count, error: countError } = await supabase
        .from("submissions")
        .select("*", { count: "exact", head: true })
        .is("superseded_at", null);

      if (countError) throw countError;

      // Fetch last 5 submissions
      const { data: recent, error: recentError } = await supabase
        .from("submissions")
        .select(RECENT_SUBMISSION_COLUMNS)
        .is("superseded_at", null)
        .order("created_at", { ascending: false })
        .limit(5);

      if (recentError) throw recentError;

      const recentRows = (recent ?? []) as RecentSubmissionRow[];

      // Fetch grade reports for completed submissions
      const completedIds = recentRows
        .filter((s) => s.status === "completed")
        .map((s) => s.id);

      let gradeMap: Record<string, Pick<GradeReportRow, "overall_score" | "grade_tier">> = {};

      if (completedIds.length > 0) {
        const { data: reports } = await supabase
          .from("grade_reports")
          .select("submission_id, overall_score, grade_tier")
          .in("submission_id", completedIds)
          .is("superseded_at", null); // US-479: active report per submission

        const reportRows = (reports ?? []) as Array<
          Pick<GradeReportRow, "overall_score" | "grade_tier"> & { submission_id: string }
        >;

        gradeMap = Object.fromEntries(
          reportRows.map((r) => [
            r.submission_id,
            { overall_score: r.overall_score, grade_tier: r.grade_tier },
          ])
        );
      }

      const merged: RecentSubmission[] = recentRows.map((s) => ({
        ...s,
        grade_report: gradeMap[s.id] ?? null,
      }));

      return { totalCount: count ?? 0, recentSubmissions: merged };
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: inventoryData } = useQuery({
    queryKey: ["dashboard-listing-suggestions"],
    queryFn: async () => {
      // US-411: the listing-suggestions widget only acts on ACTIVE inventory
      // (it skips sold/shipped/completed/returned) and reads a handful of
      // columns. Push the status filter + a candidate cap to the server and
      // select just the rendered columns so this query stays fast regardless of
      // total inventory size (was select('*') over ALL inventory_items).
      const SUGGESTION_CANDIDATE_CAP = 200;
      // Cheap index-only count (head: no rows transferred) preserves the
      // FlipdeskPromoCard's "do they have ANY inventory yet?" gate, independent
      // of the active-only candidate query below.
      // US-1636: surface query failures instead of swallowing them into a
      // wrong zero-state (an errored count/select would render "no inventory"
      // and hide the promo/suggestions with no error UI).
      const { count: totalItemCount, error: countError } = await supabase
        .from("inventory_items")
        .select("id", { count: "exact", head: true });
      if (countError) throw countError;
      const { data: itemsRaw, error: itemsError } = await supabase
        .from("inventory_items")
        .select("id, status, title, submission_id")
        .not("status", "in", "(sold,shipped,completed,returned)")
        .order("created_at", { ascending: false })
        .limit(SUGGESTION_CANDIDATE_CAP);
      if (itemsError) throw itemsError;
      const items = (itemsRaw ?? []) as unknown as InventoryItemRow[];

      const itemIds = items.map((i) => i.id);
      const allListings = await fetchInChunks<ListingRow>(itemIds, async (chunk) => {
        const { data, error } = await supabase
          .from("listings")
          .select("inventory_item_id, is_active, listed_at, platform")
          .in("inventory_item_id", chunk);
        return { data: data as unknown as ListingRow[] | null, error };
      });

      const submissionIds = items
        .map((i) => i.submission_id)
        .filter((id): id is string => id !== null);
      const allReports = await fetchInChunks<GradeReportRow>(submissionIds, async (chunk) => {
        const { data, error } = await supabase
          .from("grade_reports")
          .select("submission_id, confidence_score")
          .in("submission_id", chunk)
          .is("superseded_at", null); // US-479: active report per submission
        return { data: data as unknown as GradeReportRow[] | null, error };
      });

      return {
        items,
        listings: allListings,
        gradeReports: allReports,
        totalItemCount: totalItemCount ?? 0,
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  // US-1118: the user's own Garment Passports. RLS scopes `garments` to
  // created_by = auth.uid(), so this returns only passports they created.
  const { data: passportData } = useQuery({
    queryKey: ["dashboard-passports"],
    queryFn: async () => {
      const { data, count, error } = await supabase
        .from("garments")
        .select("public_passport_slug", { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(1);
      // US-1636: surface the failure rather than reporting zero passports.
      if (error) throw error;
      const rows = (data ?? []) as unknown as Pick<GarmentRow, "public_passport_slug">[];
      return { count: count ?? 0, latestSlug: rows[0]?.public_passport_slug ?? null };
    },
    staleTime: 5 * 60 * 1000,
  });

  const totalCount = submissionData?.totalCount ?? 0;
  const recentSubmissions = submissionData?.recentSubmissions ?? [];

  const useCase = profile?.use_case ?? null;
  const inventoryCount = inventoryData?.totalItemCount ?? 0;
  const quickActions = quickActionsFor(useCase);
  const featureCards = featureCardsFor(useCase, {
    verifiedEnabled: profile?.verified_enabled ?? false,
    verifiedHandle: profile?.verified_handle ?? null,
    passportCount: passportData?.count ?? 0,
    latestPassportSlug: passportData?.latestSlug ?? null,
  });
  const firstRun = firstRunFor(useCase);
  const FirstRunIcon = firstRun.icon;
  // Zero-data first run: no submissions AND no inventory yet (don't flash it
  // while the submission count is still loading).
  const isFirstRun = !isLoading && totalCount === 0 && inventoryCount === 0;
  // The FlipDesk reseller promo is only relevant to selling personas.
  const showFlipdeskPromo = useCase !== "buyer" && useCase !== "developer";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome back${profile?.full_name ? `, ${profile.full_name}` : ""}.`}
        actions={
          <Button onClick={() => navigate("/dashboard/submissions/new")}>
            <Plus className="mr-1 h-4 w-4" />
            New Submission
          </Button>
        }
      />

      {/* US-2108 AC4: the PWA install prompt belongs on a real-install-intent
          surface, not only FlipDesk intake / Snap. The dashboard is where an
          engaged, returning user lands. The banner self-hides unless the browser
          reports the app is installable and shares one dismiss key across mounts,
          so it never nags. `general` variant → grades/certificates copy. */}
      <PwaInstallBanner variant="general" />

      {/* US-2537: the seller's own data first. This page opened with eight
          promotional blocks — checklist, first-run card, quick actions,
          rewards, a FlipDesk promo, Discover cards, invite-a-friend and an
          impact tile — before a returning seller saw a single number about
          their own business. Stats, charts and Recent Submissions now come
          first; everything that sells something follows them. */}
      {/* US-2537: usage, rendered ONCE and up here with the seller's own
          numbers. The stats row carried a hand-built "Grades Used" card
          showing the same figure as these shared meters lower down the
          page — two sources for one number, free to disagree the moment
          either changed. The shared component wins: it also covers AI
          actions, credits and marketplaces. */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Usage</h2>
        <UsageMeters />
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Current Plan</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">{planConfig.name}</span>
              <Badge variant="secondary" className="text-xs">
                {/* US-2365: cents on the current source. The legacy shim
                    divided by 100 and mapped 0 to 0, so the two branches below
                    are the same output through one fewer indirection. There is
                    no "Custom" tier any more — the shim's null came from a
                    price the old enterprise plan never carried. */}
                {planConfig.priceMonthlyCents === 0
                  ? "Free"
                  : `${planConfig.priceMonthlyCents / 100}/mo`}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Submissions</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : isError ? (
              // US-1468: compact retry consistent with ErrorState (used by the
              // Recent Submissions card on this same page), reusing the wired
              // refetch/isFetching — not a dead "Failed to load" string.
              <div className="space-y-2" role="alert">
                <p className="text-sm text-destructive">Couldn't load</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetch()}
                  disabled={isFetching}
                >
                  <RefreshCw
                    className={cn("mr-1.5 h-3.5 w-3.5", isFetching && "animate-spin")}
                  />
                  {isFetching ? "Retrying…" : "Try again"}
                </Button>
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold">{totalCount}</div>
                <CardDescription>
                  {totalCount === 0
                    ? "No submissions yet"
                    : `${totalCount} total submission${totalCount !== 1 ? "s" : ""}`}
                </CardDescription>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Analytics charts */}
      <Suspense fallback={<ChartSkeleton />}>
        <GradeCharts />
      </Suspense>

      {/* Listing optimization suggestions */}
      {inventoryData && (
        <ListingSuggestions
          items={inventoryData.items}
          listings={inventoryData.listings}
          gradeReports={inventoryData.gradeReports}
          maxItems={5}
        />
      )}

      {/* Recent submissions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Submissions</CardTitle>
              <CardDescription>Your latest grading submissions.</CardDescription>
            </div>
            {recentSubmissions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/dashboard/submissions")}
              >
                View All
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isError ? (
            <ErrorState
              title="Couldn't load recent submissions"
              description="Something went wrong while loading your submissions. This is usually temporary."
              onRetry={() => refetch()}
              retrying={isFetching}
            />
          ) : isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-12 flex-1" />
                </div>
              ))}
            </div>
          ) : recentSubmissions.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No submissions yet"
              description="Upload photos of a garment to get your first AI-powered condition grade."
              action={{
                label: "Submit your first garment",
                onClick: () => navigate("/dashboard/submissions/new"),
                icon: Plus,
              }}
            />
          ) : (
            <div className="space-y-2">
              {recentSubmissions.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  className="flex w-full cursor-pointer items-center justify-between rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
                  onClick={() => navigate(`/dashboard/submissions/${sub.id}`)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{sub.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {new Date(sub.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge
                      variant="outline"
                      className={cn(getStatusBadgeClasses(sub.status))}
                    >
                      {formatLabel(sub.status)}
                    </Badge>
                    {sub.grade_report ? (
                      <span
                        className={cn(
                          "inline-flex min-w-[2.5rem] items-center justify-end gap-1 text-sm font-semibold",
                          getScoreColor(sub.grade_report.overall_score)
                        )}
                        title={sub.grade_report.grade_tier}
                      >
                        <ScoreBandIcon
                          score={sub.grade_report.overall_score}
                        />
                        {sub.grade_report.overall_score.toFixed(1)}
                      </span>
                    ) : (
                      <span className="min-w-[2.5rem] text-right text-sm text-muted-foreground">
                        —
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* App-wide, persona-aware activation checklist (US-1122). Self-hides once
          every step is done or the user dismisses it; renders nothing for the
          buyer persona (the first-run card below covers them). */}
      <ActivationChecklist />

      {/* Persona-tailored zero-data first run (US-1118). Suppressed for personas
          that get the multi-step activation checklist above to avoid overlap. */}
      {isFirstRun && useCase === "buyer" && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md bg-primary/10">
                <FirstRunIcon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-semibold">{firstRun.title}</p>
                <p className="text-xs text-muted-foreground">{firstRun.description}</p>
              </div>
            </div>
            <Button onClick={() => navigate(firstRun.to)} className="sm:flex-shrink-0">
              {firstRun.cta}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions — tailored to the user's use case (US-1118) */}
      <div className="grid gap-3 sm:grid-cols-3">
        {quickActions.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              key={action.key}
              variant="outline"
              className="h-auto justify-start gap-3 py-3"
              onClick={() => navigate(action.to)}
            >
              <Icon className="h-5 w-5 text-primary" />
              <span className="text-left">
                <span className="block text-sm font-medium">{action.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {action.sublabel}
                </span>
              </span>
            </Button>
          );
        })}
      </div>

      {/* US-1857: rewards at a glance — level, season, badges, quests and how
          far the next real reward is. Self-hides for a seller with nothing
          earned yet (the activation checklist above is their surface), but the
          celebration runner inside it still mounts so their first badge has a
          baseline to diff against. */}
      <RewardsWidget />


      {/* FlipDesk cross-promotion (selling personas, zero-inventory users only) */}
      {showFlipdeskPromo && (
        <FlipdeskPromoCard itemCount={inventoryData?.totalItemCount} />
      )}

      {/* Discover GradeThread — persona-relevant feature entry points (US-1118):
          Garment Passports, Verified Seller, Buyer Guarantee. */}
      {featureCards.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Discover GradeThread
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {featureCards.map((feature) => {
              const Icon = feature.icon;
              return (
                <Card key={feature.key} className="flex flex-col">
                  <CardContent className="flex flex-1 flex-col gap-3 py-4">
                    <div className="flex items-center gap-2">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-primary/10">
                        <Icon className="h-4 w-4 text-primary" />
                      </div>
                      <p className="text-sm font-medium">{feature.title}</p>
                    </div>
                    <p className="flex-1 text-xs text-muted-foreground">
                      {feature.description}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={() => navigate(feature.to)}
                    >
                      {feature.cta}
                      <ArrowRight className="ml-1.5 h-3 w-3" />
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* US-862: invite a friend — the referral program entry point (US-1118) */}
      <InviteFriendCard />

      {/* US-1787: circularity impact — "your resale diverted X" (renders only
          once the user has graded at least one item). */}
      <ImpactTile />

    </div>
  );
}
