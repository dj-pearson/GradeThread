import { useState } from "react";
import { useNavigate } from "react-router";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BarChart3, Search } from "lucide-react";
import { useHelpReport } from "@/hooks/use-help-center";
import type { HelpReport } from "@/hooks/use-help-center";

// Help Center report (US-2592).
//
// Two numbers decide whether this epic paid for itself: how much organic traffic
// the help centre earns, and how many tickets it prevents. Both are answered
// here, from the database.
//
// ⚠ NOT FROM POSTHOG, and that is the design. Every public help URL is
// server-rendered by a Pages Function and the React app never mounts on it, so
// posthog-js is not there to see the traffic that matters most. PostHog carries
// the in-app interaction events, where the app is running and consent has been
// asked for. The two are shown as separate columns and are never added up.

const WINDOWS = [7, 30, 90] as const;

export function HelpReportPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<number>(30);
  const { data, isLoading, isError, refetch } = useHelpReport(days);

  return (
    <div className="space-y-4">
      <SEO title="Help Center report" noindex />
      <PageHeader
        title="Help Center report"
        subtitle="What people read, what they couldn't find, and what it saved."
        actions={
          <Button variant="outline" onClick={() => navigate("/admin/content/help")}>
            Back to articles
          </Button>
        }
      />

      <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
        <SelectTrigger className="w-40" aria-label="Reporting window">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WINDOWS.map((w) => (
            <SelectItem key={w} value={String(w)}>
              Last {w} days
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isLoading && (
        <LoadingRegion label="Loading the report" className="p-4">
          <SkeletonRows rows={8} />
        </LoadingRegion>
      )}

      {isError && (
        <ErrorState
          title="Couldn't build the report"
          description="The help service didn't answer. Try again in a moment."
          onRetry={() => void refetch()}
        />
      )}

      {data && (
        <>
          <DeflectionPanel report={data} />
          <TopArticles report={data} />
          <ZeroResults report={data} />
          <TicketSplit report={data} />
        </>
      )}
    </div>
  );
}

// ── deflection ────────────────────────────────────────────
function DeflectionPanel({ report }: { report: HelpReport }) {
  const { deflected, tickets, rate } = report.deflection;
  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="text-base font-semibold">Tickets prevented</h2>
        <p className="mt-2 text-3xl font-bold tabular-nums">
          {/* No data is not zero. A dashboard that prints 0% for a quiet week is
              reporting a failure that did not happen. */}
          {rate === null ? "No data yet" : `${Math.round(rate * 100)}%`}
        </p>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          {deflected} {deflected === 1 ? "person" : "people"} opened a suggested article
          and left without filing a ticket. {tickets}{" "}
          {tickets === 1 ? "ticket was" : "tickets were"} filed anyway. The rate is
          deflections out of both, because deflections over tickets alone would pass
          100% the moment this works.
        </p>
      </CardContent>
    </Card>
  );
}

// ── top articles ──────────────────────────────────────────
function TopArticles({ report }: { report: HelpReport }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="text-base font-semibold">Most read</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Public views are counted server-side on the search-engine-facing pages.
          In-app views come from the reader at /dashboard/help. They are separate
          columns on purpose: an article everybody opens from inside the product
          and nobody ever finds through search is a different result.
        </p>
        {report.articles.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={BarChart3}
            title="Nothing recorded yet"
            description="Views start counting once the migration is applied and somebody reads an article."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article</TableHead>
                  <TableHead className="text-right">Public</TableHead>
                  <TableHead className="text-right">In-app</TableHead>
                  <TableHead className="text-right">Helpful</TableHead>
                  <TableHead className="text-right">Not helpful</TableHead>
                  <TableHead className="text-right">Deflections</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.articles.slice(0, 25).map((a) => (
                  <TableRow key={a.slug}>
                    <TableCell className="font-medium">{a.title}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.public_views}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.app_views}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.helpful}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.unhelpful}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.deflections}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── the backlog ───────────────────────────────────────────
function ZeroResults({ report }: { report: HelpReport }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="text-base font-semibold">What we couldn't answer</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Searches that returned nothing, grouped and ranked by how many people
          typed them. This is the writing backlog: somebody wanted an answer badly
          enough to type it and got a blank page. "Signed out" counts the share
          that came from people who were not logged in, which usually means an SEO
          gap rather than a product one.
        </p>
        {report.zero_result_queries.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={Search}
            title="Every search found something"
            description="Nothing came back empty in this window."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Query</TableHead>
                  <TableHead className="text-right">People</TableHead>
                  <TableHead className="text-right">Signed out</TableHead>
                  <TableHead>Last asked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.zero_result_queries.map((q) => (
                  <TableRow key={q.normalized}>
                    <TableCell className="font-medium">{q.sample || q.normalized}</TableCell>
                    <TableCell className="text-right tabular-nums">{q.misses}</TableCell>
                    <TableCell className="text-right tabular-nums">{q.anon_misses}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(q.last_seen).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── before and after ──────────────────────────────────────
function TicketSplit({ report }: { report: HelpReport }) {
  const { before, after, split_at, window_days, after_complete } = report.tickets;
  const categories = [
    ...new Set([...before, ...after].map((r) => r.category)),
  ].sort();
  const beforeBy = new Map(before.map((r) => [r.category, r.count]));
  const afterBy = new Map(after.map((r) => [r.category, r.count]));

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="text-base font-semibold">Tickets before and after</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Two {window_days}-day windows either side of{" "}
          {new Date(split_at).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
          , the day the most recent article shipped. The category is the support
          triage category, not the help shelf: they are different vocabularies with
          no mapping between them, and inventing one would produce a chart precise
          enough to believe and wrong in a way nobody could check.
        </p>
        {!after_complete && (
          <p className="mt-2 max-w-[70ch] text-sm font-medium">
            The "after" window has not finished yet, so a fall here is arithmetic,
            not a result.
          </p>
        )}
        {categories.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={BarChart3}
            title="No tickets in either window"
            description="Nothing to compare yet."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Before</TableHead>
                  <TableHead className="text-right">After</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((cat) => {
                  const b = beforeBy.get(cat) ?? 0;
                  const a = afterBy.get(cat) ?? 0;
                  const delta = a - b;
                  return (
                    <TableRow key={cat}>
                      <TableCell className="font-medium">{cat}</TableCell>
                      <TableCell className="text-right tabular-nums">{b}</TableCell>
                      <TableCell className="text-right tabular-nums">{a}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {delta > 0 ? `+${delta}` : delta}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
