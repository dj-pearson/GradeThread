import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  RefreshCw,
  Search,
  ExternalLink,
  Send,
  Loader2,
  ShieldCheck,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SEO } from "@/components/seo";
import { edgeFetch } from "@/lib/edge-fetch";

// US-309: Admin SEO health dashboard. Reads GSC summary (US-308), shows
// per-query / per-page leaderboards, exposes a manual GSC sync trigger,
// and a single-URL IndexNow submission box (US-296/297).
//
// Admin-only — the page sits behind <AdminRoute> at the route level and
// emits noindex via <SEO noindex />.

interface SummaryRow {
  key: string;
  impressions: number;
  clicks: number;
}

interface GscSummaryResponse {
  range: { start: string; end: string };
  configured: boolean;
  top_queries: SummaryRow[];
  top_pages: SummaryRow[];
}

interface GscSyncResponse {
  ok: boolean;
  configured: boolean;
  inserted: number;
  startDate?: string;
  endDate?: string;
  error?: string;
}

function useSeoSummary() {
  return useQuery<GscSummaryResponse>({
    queryKey: ["admin_seo_summary"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/seo/summary");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load SEO summary.");
      return json as GscSummaryResponse;
    },
  });
}

function useGscSync() {
  const qc = useQueryClient();
  return useMutation<GscSyncResponse, Error, void>({
    mutationFn: async () => {
      const res = await edgeFetch("/api/admin/seo/gsc/sync", {
        method: "POST",
        json: {},
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "GSC sync failed.");
      return json as GscSyncResponse;
    },
    onSuccess: (data) => {
      if (!data.configured) {
        toast.error("GSC isn't configured yet — set the service-account env vars.");
        return;
      }
      toast.success(
        `GSC synced — ${data.inserted} rows for ${data.startDate} → ${data.endDate}.`,
      );
      qc.invalidateQueries({ queryKey: ["admin_seo_summary"] });
    },
    onError: (err) => toast.error(err.message),
  });
}

interface IndexNowAdminResponse {
  ok: boolean;
  submitted: number | null;
}

function useIndexNowSubmit() {
  return useMutation<IndexNowAdminResponse, Error, { url: string }>({
    mutationFn: async ({ url }) => {
      const res = await edgeFetch("/api/admin/seo/indexnow", {
        method: "POST",
        json: { urls: [url] },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "IndexNow submission failed.");
      return json as IndexNowAdminResponse;
    },
    onSuccess: (data) => {
      // submitUrls returns null when IndexNow isn't configured (no key file).
      if (data.submitted == null) {
        toast.warning("IndexNow isn't configured — set INDEXNOW_KEY in the edge env.");
        return;
      }
      toast.success(`IndexNow accepted the URL (${data.submitted}).`);
    },
    onError: (err) => toast.error(err.message),
  });
}

export function AdminSeoPage() {
  const summary = useSeoSummary();
  const sync = useGscSync();
  const indexNow = useIndexNowSubmit();
  const [submitUrl, setSubmitUrl] = useState("");

  return (
    <div className="space-y-6">
      <SEO title="SEO Health" noindex />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <TrendingUp className="h-6 w-6 text-brand-red" />
            SEO Health
          </h1>
          <p className="text-sm text-muted-foreground">
            Search Console performance, IndexNow submissions, and crawler
            verification — for platform-level monitoring.
          </p>
        </div>
        <Button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
        >
          {sync.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Sync GSC now
        </Button>
      </div>

      {summary.data && !summary.data.configured && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
            <div>
              <h2 className="font-semibold">Google Search Console not configured</h2>
              <p className="text-sm text-muted-foreground">
                Set <code>GSC_SERVICE_ACCOUNT_EMAIL</code>,{" "}
                <code>GSC_SERVICE_ACCOUNT_PRIVATE_KEY</code>, and{" "}
                <code>GSC_SITE_URL</code> in the edge service env, grant the
                service account read access in Search Console, then click{" "}
                <strong>Sync GSC now</strong>. Query and page data will appear here.
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <SummaryTable
          title="Top queries (28d)"
          icon={<Search className="h-4 w-4" />}
          rows={summary.data?.top_queries ?? []}
          isLoading={summary.isLoading}
          label="Query"
        />
        <SummaryTable
          title="Top pages (28d)"
          icon={<ExternalLink className="h-4 w-4" />}
          rows={summary.data?.top_pages ?? []}
          isLoading={summary.isLoading}
          label="Page"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Submit a URL to IndexNow
          </CardTitle>
          <CardDescription>
            Push a single URL to Bing/Yandex/Seznam via IndexNow for
            instant re-crawl. New content is automatically submitted at
            publish; this is for re-submission after a fix.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!submitUrl.trim()) return;
              indexNow.mutate({ url: submitUrl.trim() });
            }}
          >
            <Input
              type="url"
              placeholder="https://gradethread.com/some/page"
              value={submitUrl}
              onChange={(e) => setSubmitUrl(e.target.value)}
              className="w-full max-w-md"
              required
            />
            <Button type="submit" disabled={indexNow.isPending || !submitUrl.trim()}>
              {indexNow.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              Submit
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTable({
  title,
  icon,
  rows,
  isLoading,
  label,
}: {
  title: string;
  icon: React.ReactNode;
  rows: SummaryRow[];
  isLoading: boolean;
  label: string;
}) {
  const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        <CardDescription className="flex flex-wrap gap-3 text-xs">
          <span>
            <strong>{totalImpressions.toLocaleString()}</strong> impressions
          </span>
          <span>
            <strong>{totalClicks.toLocaleString()}</strong> clicks
          </span>
          <Badge variant="secondary">{ctr.toFixed(2)}% CTR</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No data yet — run "Sync GSC now" to pull the trailing window.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{label}</TableHead>
                <TableHead className="text-right">Impr.</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 20).map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="max-w-xs truncate" title={r.key}>
                    {r.key}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.impressions.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.clicks.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
