import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Search,
  Loader2,
  RefreshCw,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SEO } from "@/components/seo";
import { cn } from "@/lib/utils";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1072: Keyword Research. Browses the keyword library ingested from the
// Google Ads keyword planner — search volume, competition and CPC — grouped by
// theme, with a manual "refresh now" that triggers an ingestion run.
//
// Admin-only — behind <AdminRoute> at the route level; emits noindex via <SEO>.

type Competition = "low" | "medium" | "high" | "unspecified";

interface KeywordTerm {
  id: string;
  keyword: string;
  theme: string | null;
  avg_monthly_searches: number | null;
  competition: Competition;
  competition_index: number | null;
  cpc_low: number | null;
  cpc_high: number | null;
  source: string;
  last_seen_at: string;
}

interface KeywordsResponse {
  keywords: KeywordTerm[];
  themeCounts: Record<string, number>;
  configured: boolean;
}

interface IngestRun {
  id: string;
  trigger: string;
  status: "running" | "success" | "error" | "skipped";
  seeds: string[];
  keywords_returned: number;
  keywords_ingested: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const COMPETITION_STYLES: Record<Competition, string> = {
  low: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  unspecified: "bg-muted text-muted-foreground",
};

function formatVolume(v: number | null): string {
  if (v == null) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return String(v);
}

function formatCpc(low: number | null, high: number | null): string {
  if (low == null && high == null) return "—";
  if (low != null && high != null) return `$${low.toFixed(2)}–$${high.toFixed(2)}`;
  const v = (low ?? high)!;
  return `$${v.toFixed(2)}`;
}

export function AdminKeywordResearchPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState("all");
  const [competition, setCompetition] = useState("all");

  const keywordsQuery = useQuery<KeywordsResponse>({
    queryKey: ["admin_keyword_research", theme, competition, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (theme !== "all") params.set("theme", theme);
      if (competition !== "all") params.set("competition", competition);
      if (search.trim()) params.set("q", search.trim());
      const res = await edgeFetch(`/api/admin/ads/keywords?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load keywords.");
      return json as KeywordsResponse;
    },
  });

  const runsQuery = useQuery<IngestRun[]>({
    queryKey: ["admin_keyword_research_runs"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/ads/keywords/runs");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load runs.");
      return (json.runs ?? []) as IngestRun[];
    },
  });

  const ingest = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch("/api/admin/ads/keywords/ingest", { method: "POST", json: {} });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ingestion failed.");
      return json as { status: string; keywordsIngested: number; error?: string };
    },
    onSuccess: (data) => {
      if (data.status === "skipped") {
        toast.info("Google Ads not configured — nothing ingested. See ENVIRONMENT.md §2j.");
      } else if (data.status === "error") {
        toast.error(`Ingestion error: ${data.error ?? "unknown"}`);
      } else {
        toast.success(`Ingested ${data.keywordsIngested} keyword(s).`);
      }
      qc.invalidateQueries({ queryKey: ["admin_keyword_research"] });
      qc.invalidateQueries({ queryKey: ["admin_keyword_research_runs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = keywordsQuery.data;
  const keywords = data?.keywords ?? [];

  // Group the (already filtered) list by theme for display.
  const grouped = useMemo(() => {
    const map = new Map<string, KeywordTerm[]>();
    for (const k of keywords) {
      const t = k.theme ?? "general";
      if (!map.has(t)) map.set(t, []);
      map.get(t)!.push(k);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [keywords]);

  const themeOptions = useMemo(
    () => Object.keys(data?.themeCounts ?? {}).sort(),
    [data?.themeCounts],
  );

  const lastRun = runsQuery.data?.[0];

  return (
    <div className="space-y-6">
      <SEO title="Keyword Research — Admin" noindex />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <TrendingUp className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Keyword Research</h1>
            <p className="text-sm text-muted-foreground">
              Real demand data — search volume, competition &amp; CPC — from the Google Ads keyword
              planner. Grounds ad copy, SEO and ASO in measured intent.
            </p>
          </div>
        </div>
        <Button onClick={() => ingest.mutate()} disabled={ingest.isPending}>
          {ingest.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh now
        </Button>
      </div>

      {data && !data.configured && (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <span>
              Google Ads API isn&apos;t configured yet, so a refresh will no-op. Add the
              <code className="mx-1 rounded bg-muted px-1">GOOGLE_ADS_*</code>
              env vars (see ENVIRONMENT.md §2j) to enable ingestion.
            </span>
          </CardContent>
        </Card>
      )}

      {/* ── Last run ── */}
      {lastRun && (
        <p className="text-xs text-muted-foreground">
          Last run: <span className="font-medium">{lastRun.status}</span> ·{" "}
          {lastRun.keywords_ingested} ingested · {new Date(lastRun.created_at).toLocaleString()}
          {lastRun.error ? ` · ${lastRun.error}` : ""}
        </p>
      )}

      {/* ── Filters ── */}
      <Card>
        <CardHeader>
          <CardTitle>Browse keywords</CardTitle>
          <CardDescription>Filter by theme or competition, or search the phrase.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-56 flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search keyword…"
                className="pl-8"
              />
            </div>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All themes</SelectItem>
                {themeOptions.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t} ({data?.themeCounts[t] ?? 0})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={competition} onValueChange={setCompetition}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Competition" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All competition</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="unspecified">Unspecified</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {keywordsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : keywords.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No keywords yet. Click <span className="font-medium">Refresh now</span> to ingest from
              the Google Ads keyword planner.
            </p>
          ) : (
            <div className="space-y-6">
              {grouped.map(([groupTheme, items]) => (
                <div key={groupTheme}>
                  <div className="mb-2 flex items-center gap-2">
                    <Badge variant="secondary" className="capitalize">{groupTheme}</Badge>
                    <span className="text-xs text-muted-foreground">{items.length} keyword(s)</span>
                  </div>
                  <div className="overflow-hidden rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Keyword</th>
                          <th className="px-3 py-2 text-right font-medium">Volume</th>
                          <th className="px-3 py-2 text-left font-medium">Competition</th>
                          <th className="px-3 py-2 text-right font-medium">CPC range</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((k) => (
                          <tr key={k.id} className="border-t">
                            <td className="px-3 py-2">{k.keyword}</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatVolume(k.avg_monthly_searches)}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-xs font-medium capitalize",
                                  COMPETITION_STYLES[k.competition],
                                )}
                              >
                                {k.competition}
                                {k.competition_index != null ? ` ${k.competition_index}` : ""}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatCpc(k.cpc_low, k.cpc_high)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
