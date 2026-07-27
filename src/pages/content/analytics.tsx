import { Link } from "react-router-dom";
import { Mail } from "lucide-react";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import {
  useContentSettings,
  useContentStats,
  useSendContentDigest,
} from "@/hooks/use-content";
import { PRODUCT_LABELS } from "@/lib/constants";
import { safeHref } from "@/lib/safe-url";

// At-a-glance health for the content module. No external analytics —
// everything is derived from data already in the DB. Useful answers:
//   - Is the topic bank healthy across all 4 slices?
//   - How many posts went live in the last week / month?
//   - Are webhooks succeeding?
//   - What's the rough AI token spend?
//   - What's the most recent activity?
export function ContentAnalyticsPage() {
  const { data: stats, isLoading } = useContentStats();
  const { data: settings } = useContentSettings();
  const sendDigest = useSendContentDigest();

  if (isLoading || !stats) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const successRate = stats.webhooks.success_rate_last_100;
  const successPct =
    successRate === null ? null : Math.round(successRate * 100);

  // Sum across products for "headline" published counts.
  const sumValues = (m: Record<string, number>) =>
    Object.values(m).reduce((a, b) => a + b, 0);
  const blog7Total = sumValues(stats.published_7d.blog);
  const blog30Total = sumValues(stats.published_30d.blog);
  const social7Total = sumValues(stats.published_7d.social);
  const social30Total = sumValues(stats.published_30d.social);

  // Recent feed: interleave blog + social by published_at desc.
  const recentFeed = [
    ...stats.recent.blog.map((b) => ({
      kind: "blog" as const,
      id: b.id,
      title: b.title,
      url: `/admin/content/blog/editor/${b.id}`,
      published_at: b.published_at,
      product_focus: b.product_focus,
      external_url: `/blog/${b.slug}`,
    })),
    ...stats.recent.social.map((s) => ({
      kind: "social" as const,
      id: s.id,
      title:
        (s.short_body || s.long_body || "social post")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120),
      url: `/admin/content/social/editor/${s.id}`,
      published_at: s.published_at,
      product_focus: s.product_focus,
      external_url: null,
    })),
  ]
    .sort(
      (a, b) =>
        new Date(b.published_at).getTime() -
        new Date(a.published_at).getTime(),
    )
    .slice(0, 12);

  return (
    <div className="space-y-6">
      <SEO title="Content Analytics" noindex />
      <PageHeader
        title="Content Analytics"
        subtitle="Health of the content pipeline at a glance. Refreshes every minute."
        actions={
          /* US-880: send the weekly digest email on demand to verify delivery
             + the tuning recommendations. */
          <Button
            variant="outline"
            onClick={() => sendDigest.mutate()}
            disabled={sendDigest.isPending}
          >
            <Mail className="mr-2 h-4 w-4" />
            {sendDigest.isPending ? "Sending…" : "Send weekly digest"}
          </Button>
        }
      />

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="Blog · last 7d"
          value={blog7Total}
          subtitle={`${blog30Total} in 30d`}
        />
        <Stat
          label="Social · last 7d"
          value={social7Total}
          subtitle={`${social30Total} in 30d`}
        />
        <Stat
          label="Webhook success"
          value={successPct === null ? "—" : `${successPct}%`}
          subtitle={
            stats.webhooks.failed_last_7d > 0
              ? `${stats.webhooks.failed_last_7d} failed in 7d`
              : "no failures in 7d"
          }
          tone={
            successRate !== null && successRate < 0.9 ? "warn" : "default"
          }
        />
        <Stat
          label="AI tokens · 30d"
          value={formatTokens(
            stats.ai_usage_30d.input_tokens + stats.ai_usage_30d.output_tokens,
          )}
          subtitle={`${formatTokens(stats.ai_usage_30d.input_tokens)} in / ${formatTokens(stats.ai_usage_30d.output_tokens)} out`}
        />
      </div>

      {/* Autopilot status — what mode the scheduler is running in right now.
          Confirms the safe-rollout state at a glance (US-852). */}
      {settings && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Autopilot</CardTitle>
          </CardHeader>
          <CardContent>
            {settings.publishing_paused && (
              <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive">
                Publishing is paused — the scheduler tick is doing nothing
                (kill-switch). Manual publishing still works.
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <AutopilotStat
                label="Blog autopilot"
                on={settings.auto_publish_blog && !settings.publishing_paused}
                detail={`${settings.post_cadence_per_day_blog}/day cadence`}
              />
              <AutopilotStat
                label="Social autopilot"
                on={settings.auto_publish_social && !settings.publishing_paused}
                detail={`${settings.post_cadence_per_day_social}/day cadence`}
              />
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Weekly ceiling
                </p>
                <p className="mt-1 text-lg font-semibold">
                  {settings.max_auto_publishes_per_week}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  hard cap, blog + social
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Min topics in bank
                </p>
                <p className="mt-1 text-lg font-semibold">
                  {settings.min_topics_in_bank}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  auto-refills in batches of {settings.topics_refill_batch}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              When an autopilot is off, the scheduler still generates drafts at
              cadence — they just wait for a manual publish. Tune everything in{" "}
              <Link
                to="/admin/content/settings"
                className="underline underline-offset-2"
              >
                Content Settings
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}

      {/* Topic bank levels */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Topic bank levels</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Slice</th>
                <th className="py-2 text-right">Queued</th>
                <th className="py-2 text-right">Assigned</th>
                <th className="py-2 text-right">Used</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["blog", "gradethread"],
                  ["blog", "flipdesk"],
                  ["social", "gradethread"],
                  ["social", "flipdesk"],
                ] as const
              ).map(([surface, product]) => {
                const queued = stats.bank[`${surface}:${product}:queued`] ?? 0;
                const assigned =
                  stats.bank[`${surface}:${product}:assigned`] ?? 0;
                const used = stats.bank[`${surface}:${product}:used`] ?? 0;
                const low = queued < 3;
                return (
                  <tr key={`${surface}:${product}`} className="border-t">
                    <td className="py-2 capitalize">
                      {surface} · {PRODUCT_LABELS[product]}
                    </td>
                    <td className="py-2 text-right">
                      <Badge variant={low ? "destructive" : "secondary"}>
                        {queued}
                      </Badge>
                    </td>
                    <td className="py-2 text-right text-muted-foreground">
                      {assigned}
                    </td>
                    <td className="py-2 text-right text-muted-foreground">
                      {used}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            The scheduler auto-refills any slice that dips below the configured
            minimum in{" "}
            <Link
              to="/admin/content/settings"
              className="underline underline-offset-2"
            >
              Content Settings
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      {/* Published breakdown */}
      <div className="grid gap-4 md:grid-cols-2">
        <PublishedCard
          title="Blog · last 30d"
          counts={stats.published_30d.blog}
        />
        <PublishedCard
          title="Social · last 30d"
          counts={stats.published_30d.social}
        />
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {recentFeed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing published yet.
            </p>
          ) : (
            <ul className="divide-y">
              {recentFeed.map((item) => (
                <li key={`${item.kind}:${item.id}`} className="py-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge
                      variant={item.kind === "blog" ? "default" : "secondary"}
                    >
                      {item.kind}
                    </Badge>
                    <span>
                      {PRODUCT_LABELS[
                        item.product_focus as keyof typeof PRODUCT_LABELS
                      ] ?? item.product_focus}
                    </span>
                    <span>·</span>
                    <span>{new Date(item.published_at).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-sm">
                    <Link
                      to={item.url}
                      className="font-medium hover:underline"
                    >
                      {item.title}
                    </Link>
                    {safeHref(item.external_url) && (
                      <a
                        href={safeHref(item.external_url) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        view live ↗
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  subtitle,
  tone = "default",
}: {
  label: string;
  value: number | string;
  subtitle?: string;
  tone?: "default" | "warn";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase text-muted-foreground">{label}</p>
        <p
          className={`mt-1 text-2xl font-bold ${
            tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""
          }`}
        >
          {value}
        </p>
        {subtitle && (
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

function AutopilotStat({
  label,
  on,
  detail,
}: {
  label: string;
  on: boolean;
  detail: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-1">
        <Badge variant={on ? "default" : "secondary"}>{on ? "On" : "Off"}</Badge>
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function PublishedCard({
  title,
  counts,
}: {
  title: string;
  counts: Record<string, number>;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing published in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {(["gradethread", "flipdesk", "both"] as const).map((p) => {
                const c = counts[p] ?? 0;
                const pct = total > 0 ? Math.round((c / total) * 100) : 0;
                return (
                  <tr key={p} className="border-t">
                    <td className="py-2">{PRODUCT_LABELS[p]}</td>
                    <td className="py-2 text-right font-semibold">{c}</td>
                    <td className="py-2 pl-3 text-right text-xs text-muted-foreground">
                      {pct}%
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t font-medium">
                <td className="py-2">Total</td>
                <td className="py-2 text-right">{total}</td>
                <td className="py-2"></td>
              </tr>
            </tbody>
          </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
