import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { edgeFetch } from "@/lib/edge-fetch";
import { CHART_PALETTE } from "@/lib/constants";
import {
  buyerMrrCents,
  BUYER_TRACKED_FEATURES,
  type BuyerPlanMixRow,
  type BuyerTrackedFeature,
} from "@/lib/buyer-analytics";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Bell,
  Chrome,
  CircleDollarSign,
  Repeat,
  ShieldCheck,
  ShoppingBag,
  Shirt,
  Sparkles,
  UserCheck,
  Users,
  Video,
} from "lucide-react";

// US-1845: the buyer half of the growth surface.
//
// Everything here comes from ONE call (`/api/admin/growth/buyer`), so the funnel,
// the plan mix and the attribution table all describe the same window. MRR is
// computed on this side from BUYER_PLANS — see buyerMrrCents for why the prices
// stay out of the SQL.

interface AdoptionCell {
  users: number;
  events: number;
}

interface AttributionRow {
  source: string;
  medium: string | null;
  campaign: string | null;
  buyers: number;
  paid_buyers: number;
  guard_monthly: number;
  guard_yearly: number;
  connoisseur_monthly: number;
  connoisseur_yearly: number;
  metered_units: number;
}

interface BuyerGrowth {
  window_days: number;
  funnel: {
    buyer_accounts: number;
    new_accounts: number;
    activated: number;
    paid: number;
    active_recent: number;
  };
  plans: BuyerPlanMixRow[];
  adoption: Record<BuyerTrackedFeature, AdoptionCell>;
  flywheel: { date: string; buyer_demand: number; seller_grades: number }[];
  flywheel_summary: {
    correlation: number | null;
    days: number;
    buyer_demand_total: number;
    seller_grades_total: number;
    grades_per_demand: number | null;
  };
  attribution: AttributionRow[];
}

const FEATURE_LABELS: Record<BuyerTrackedFeature, { label: string; icon: typeof Bell }> = {
  extension_check: { label: "Extension checks", icon: Chrome },
  alerts: { label: "Condition alerts", icon: Bell },
  confirmations: { label: "Grade confirmations", icon: UserCheck },
  guarantee_claims: { label: "Guarantee claims", icon: ShieldCheck },
  portfolio: { label: "Closet portfolio", icon: Shirt },
  wants: { label: "Graded Wanted", icon: ShoppingBag },
  authenticity: { label: "Authenticity checks", icon: Sparkles },
  video_grade: { label: "Video grades", icon: Video },
};

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function rate(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** The attribution row's paid mix, in the shape buyerMrrCents consumes. */
function attributionMix(row: AttributionRow): BuyerPlanMixRow[] {
  return [
    { plan: "guard", interval: "monthly", users: row.guard_monthly },
    { plan: "guard", interval: "yearly", users: row.guard_yearly },
    { plan: "connoisseur", interval: "monthly", users: row.connoisseur_monthly },
    { plan: "connoisseur", interval: "yearly", users: row.connoisseur_yearly },
  ];
}

export function BuyerGrowthPage() {
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["admin-buyer-growth"],
    queryFn: async (): Promise<BuyerGrowth> => {
      const res = await edgeFetch("/api/admin/growth/buyer?days=30");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load buyer growth");
      return json;
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
  });

  // US-2507: isError FIRST. This page already had an error branch, but it sat
  // BELOW the `isLoading || !data` guard — and an errored query leaves `data`
  // undefined, so that guard always won and the error branch was unreachable.
  // The operator got the loading skeleton forever.
  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Users} title="Buyer growth" />
        <ErrorState
          title="Couldn't load the buyer growth metrics"
          description="The funnel is still being tracked — we just couldn't fetch it right now."
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Users} title="Buyer growth" subtitle="Loading the buyer funnel." />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const f = data.funnel;
  const mrrCents = buyerMrrCents(data.plans);
  const fw = data.flywheel_summary;

  // Per-tier MRR, from the same mix rows the total uses.
  const tiers = (["guard", "connoisseur"] as const).map((plan) => ({
    plan,
    users: data.plans
      .filter((p) => p.plan === plan && (p.status === "active" || p.status === "trialing"))
      .reduce((a, p) => a + p.users, 0),
    cents: buyerMrrCents(data.plans.filter((p) => p.plan === plan)),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Users}
        title="Buyer growth"
        subtitle={
          <>
            The buyer funnel, plan mix, feature adoption and the two-sided
            flywheel. Last {data.window_days} days.
          </>
        }
      />

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">
          Funnel
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat icon={Users} label="Buyer accounts" value={f.buyer_accounts} />
          <Stat
            icon={Sparkles}
            label="New this window"
            value={f.new_accounts}
          />
          <Stat
            icon={UserCheck}
            label="Activated"
            value={f.activated}
            hint={`${rate(f.activated, f.buyer_accounts)} of accounts did something`}
          />
          <Stat
            icon={CircleDollarSign}
            label="Paying"
            value={f.paid}
            hint={`${rate(f.paid, f.buyer_accounts)} conversion`}
          />
          <Stat
            icon={Repeat}
            label="Active in window"
            value={f.active_recent}
            hint={`${rate(f.active_recent, f.buyer_accounts)} retained`}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">
          Recurring revenue
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat
            icon={CircleDollarSign}
            label="Buyer MRR"
            value={money(mrrCents)}
            hint="Yearly plans counted at a twelfth"
          />
          {tiers.map((t) => (
            <Stat
              key={t.plan}
              icon={CircleDollarSign}
              label={`${t.plan === "guard" ? "Guard" : "Connoisseur"} MRR`}
              value={money(t.cents)}
              hint={`${t.users} subscriber${t.users === 1 ? "" : "s"}`}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">
          Feature adoption
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BUYER_TRACKED_FEATURES.map((key) => {
            const cell = data.adoption[key] ?? { users: 0, events: 0 };
            const meta = FEATURE_LABELS[key];
            return (
              <Stat
                key={key}
                icon={meta.icon}
                label={meta.label}
                value={cell.users}
                hint={`${cell.events} action${cell.events === 1 ? "" : "s"} · ${rate(cell.users, f.buyer_accounts)} of buyers`}
              />
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Authenticity is counted from the current billing period's meter — it has
          no table of its own, so it is the one tile not bounded by the window.
        </p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Flywheel — buyer demand vs seller grading</CardTitle>
          <CardDescription>
            {fw.correlation === null
              ? `Not measurable over ${fw.days} day${fw.days === 1 ? "" : "s"} — one side has no variation yet.`
              : `Daily correlation ${fw.correlation.toFixed(2)} over ${fw.days} days. ${
                  fw.grades_per_demand === null
                    ? "No buyer demand recorded."
                    : `${fw.grades_per_demand} seller grades per unit of buyer demand.`
                }`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.flywheel.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={data.flywheel} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => d.slice(5)}
                  fontSize={11}
                  stroke="currentColor"
                  className="text-muted-foreground"
                />
                <YAxis
                  allowDecimals={false}
                  fontSize={11}
                  stroke="currentColor"
                  className="text-muted-foreground"
                />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="buyer_demand"
                  name="Buyer demand (checks, alerts, wants)"
                  stroke={CHART_PALETTE.red}
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="seller_grades"
                  name="Seller grading submissions"
                  stroke={CHART_PALETTE.navy}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-6 text-sm text-muted-foreground">Nothing recorded in this window yet.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            A correlation is not a cause. Two series moving together over a few
            weeks is a prompt to look, not a proof that buyer demand produced the
            grading.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revenue by acquisition source</CardTitle>
          <CardDescription>
            First-touch channel, falling back to the earned link and then to
            direct. Metered units are extension checks, authenticity and video
            credits spent this period.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.attribution.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No buyers attributed yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Source</th>
                    <th className="py-2 pr-4 font-medium">Campaign</th>
                    <th className="py-2 pr-4 text-right font-medium">Buyers</th>
                    <th className="py-2 pr-4 text-right font-medium">Paying</th>
                    <th className="py-2 pr-4 text-right font-medium">Conv.</th>
                    <th className="py-2 pr-4 text-right font-medium">MRR</th>
                    <th className="py-2 text-right font-medium">Credits used</th>
                  </tr>
                </thead>
                <tbody>
                  {data.attribution.map((row, i) => (
                    <tr key={`${row.source}-${row.medium}-${row.campaign}-${i}`} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <span className="font-medium">{row.source}</span>
                        {row.medium && (
                          <span className="ml-1 text-xs text-muted-foreground">/ {row.medium}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{row.campaign ?? "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.buyers}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.paid_buyers}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {rate(row.paid_buyers, row.buyers)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {money(buyerMrrCents(attributionMix(row)))}
                      </td>
                      <td className="py-2 text-right tabular-nums">{row.metered_units}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
