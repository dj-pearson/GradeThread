import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import {
  BadgeCheck,
  BookMarked,
  CircleAlert,
  Loader2,
  Pencil,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { safeHref } from "@/lib/safe-url";

// US-1715: admin authoring + verification surface for the Brand & Style
// Knowledge Base (/api/admin/brand-knowledge). Reviewers confirm AI-drafted /
// seeded facts (verified=true), correct them, or drop bad ones — every fact
// shows its source_url + confidence so the call is informed. The pack preview
// shows EXACTLY what the extractor (US-1713) receives for the brand.

const CHILD_SECTIONS = [
  { key: "styles", table: "brand_styles", label: "Styles", title: "style_name" },
  { key: "codes", table: "brand_style_codes", label: "Decoders", title: "decoder_kind" },
  { key: "colorways", table: "brand_colorways", label: "Colorways", title: "color_name" },
  { key: "charts", table: "brand_size_charts", label: "Size charts", title: "garment" },
] as const;

interface BrandRow {
  id: string;
  brand_key: string;
  canonical_brand: string;
  aliases: string[] | null;
  verified: boolean;
  confidence: number | null;
  source_url: string | null;
  counts: Record<string, number>;
}

type Fact = Record<string, unknown> & {
  id: string;
  source_url: string | null;
  confidence: number | null;
  verified: boolean;
};

interface BrandDetail {
  knowledge: Fact | null;
  styles: Fact[];
  codes: Fact[];
  colorways: Fact[];
  charts: Fact[];
  pack: {
    source: string;
    styles: unknown[];
    decoders: unknown[];
    colorways: unknown[];
    sizingCharts: unknown[];
  } | null;
}

async function api(path: string, method = "GET", body?: unknown) {
  const res = await edgeFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
}

function ConfidenceBadge({ c }: { c: number | null }) {
  if (c == null) return <Badge variant="outline">no conf.</Badge>;
  const variant = c >= 0.85 ? "default" : c >= 0.6 ? "secondary" : "destructive";
  return <Badge variant={variant}>{c.toFixed(2)}</Badge>;
}

function VerifiedBadge({ v }: { v: boolean }) {
  return v
    ? (
      <Badge className="gap-1" variant="default">
        <BadgeCheck className="h-3 w-3" /> verified
      </Badge>
    )
    : (
      <Badge className="gap-1" variant="outline">
        <CircleAlert className="h-3 w-3" /> unverified
      </Badge>
    );
}

// Editable columns per table (mirrors the edge KB_TABLES allow-list). brand_key
// is intentionally absent — the server rejects it anyway.
const EDITABLE: Record<string, string[]> = {
  brand_knowledge: [
    "canonical_brand", "aliases", "category_focus", "registered_numbers",
    "tag_eras", "country_patterns", "authentication_tells", "notes",
    "source_url", "confidence", "verified",
  ],
  brand_styles: [
    "style_name", "aliases", "product_line", "department", "category",
    "visual_fingerprint", "fabric_tech", "era", "msrp_band", "keywords",
    "source_url", "confidence", "verified",
  ],
  brand_style_codes: [
    "decoder_kind", "description", "pattern", "extraction_rules", "examples",
    "source_url", "confidence", "verified",
  ],
  brand_colorways: ["color_name", "aliases", "hex", "years", "source_url", "confidence", "verified"],
  brand_size_charts: [
    "brand_label", "brand_match", "department", "garment", "category_match",
    "rows", "note", "source_url", "confidence", "verified",
  ],
};

// US-2693: the learned style-code review queue. Shapes mirror
// lib/style-code-review.ts; the ORDER is decided there, not here — the page
// renders what the queue hands it.
interface ReviewCandidate {
  id?: string;
  name: string;
  source: string;
  supporting: number;
  confidence: number;
  evidenceUrl: string | null;
  rejected: boolean;
}

interface ReviewItem {
  brandKey: string;
  styleCodeNorm: string;
  styleCodeRaw: string;
  resolved: { name: string; source: string; supporting: number } | null;
  candidates: ReviewCandidate[];
  conflicting: boolean;
  priority: number;
}

interface ReviewResponse {
  items: ReviewItem[];
  total: number;
  truncated: boolean;
}

interface CrawlRow {
  brand_key: string;
  brand: string;
  last_run_at: string | null;
  page_offset: number;
  pass_count: number;
  listings_seen: number;
  codes_found: number;
  empty_passes: number;
  /** Codes found per listing scanned. Null until a brand has been crawled. */
  codes_per_listing: number | null;
  exhausted: boolean;
}

export function AdminBrandKnowledgePage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<{ table: string; fact: Fact } | null>(null);
  const [editJson, setEditJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ table: string; fact: Fact } | null>(null);
  // US-2693: promoting needs a source URL. That is the DATABASE's rule, not a
  // form preference — brand_styles carries
  // CHECK (brand_fact_is_sourced(source_url, confidence)) — so the dialog is
  // where an admin supplies one when the learned row has no evidence link,
  // which is every seller correction.
  const [promoteTarget, setPromoteTarget] = useState<ReviewCandidate | null>(null);
  const [promoteSource, setPromoteSource] = useState("");
  const [promoteDepartment, setPromoteDepartment] = useState("");

  const { data: brands, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["admin-brand-kb"],
    queryFn: async (): Promise<BrandRow[]> => (await api("/api/admin/brand-knowledge")).brands ?? [],
    staleTime: 30 * 1000,
  });

  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailError,
    refetch: refetchDetail,
    isFetching: detailFetching,
  } = useQuery({
    queryKey: ["admin-brand-kb", selected],
    queryFn: async (): Promise<BrandDetail> => await api(`/api/admin/brand-knowledge/${selected}`),
    enabled: !!selected,
  });

  const {
    data: review,
    isLoading: reviewLoading,
    isError: reviewError,
    refetch: refetchReview,
    isFetching: reviewFetching,
  } = useQuery({
    queryKey: ["admin-brand-kb", "style-codes"],
    queryFn: async (): Promise<ReviewResponse> =>
      await api("/api/admin/brand-knowledge/style-codes/review?limit=100"),
    staleTime: 30 * 1000,
  });

  // US-2787: which brand's crawl is in flight, or "__rotation__" for the whole
  // nightly rotation. One value rather than a boolean per row, because the job
  // lock allows exactly one crawl at a time anyway.
  const [crawling, setCrawling] = useState<string | null>(null);

  const {
    data: crawl,
    isLoading: crawlLoading,
    isError: crawlError,
    refetch: refetchCrawl,
    isFetching: crawlFetching,
  } = useQuery({
    queryKey: ["admin-brand-kb", "discovery"],
    queryFn: async (): Promise<{ brands: CrawlRow[] }> =>
      await api("/api/admin/brand-knowledge/style-codes/discovery"),
    staleTime: 60 * 1000,
  });

  const refreshReview = () =>
    void queryClient.invalidateQueries({
      queryKey: ["admin-brand-kb", "style-codes"],
    });

  async function runCrawl(brandKey?: string) {
    setCrawling(brandKey ?? "__rotation__");
    try {
      const result = await api(
        "/api/admin/brand-knowledge/style-codes/discovery/run",
        "POST",
        brandKey ? { brand_key: brandKey } : {},
      );
      if (result.skipped) {
        // The job lock, not an error. Saying so keeps a second click from
        // reading as a failure.
        toast.info("A crawl is already running. Nothing was started.");
      } else {
        toast.success(
          `Crawled ${result.crawled ?? 0} brand(s): ${result.newCodes ?? 0} new ` +
            `code(s), ${result.names ?? 0} name(s) from ${result.inspected ?? 0} listings.`,
        );
      }
      void queryClient.invalidateQueries({
        queryKey: ["admin-brand-kb", "discovery"],
      });
      refreshReview();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The crawl failed to start");
    } finally {
      setCrawling(null);
    }
  }

  function openPromote(cand: ReviewCandidate) {
    setPromoteTarget(cand);
    setPromoteSource(cand.evidenceUrl ?? "");
    setPromoteDepartment("");
  }

  async function confirmPromote() {
    const cand = promoteTarget;
    if (!cand?.id) return;
    setBusyId(cand.id);
    try {
      await api(`/api/admin/brand-knowledge/style-codes/${cand.id}/promote`, "POST", {
        source_url: promoteSource,
        department: promoteDepartment,
      });
      toast.success("Promoted to brand knowledge.");
      setPromoteTarget(null);
      refreshReview();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Promote failed");
    } finally {
      setBusyId(null);
    }
  }

  async function rejectName(id: string) {
    setBusyId(id);
    try {
      await api(`/api/admin/brand-knowledge/style-codes/${id}/reject`, "POST");
      // Recorded, not deleted: the sweep would hand a deleted name straight
      // back next tick from the same listings.
      toast.success("Rejected. The sweep will not re-learn it.");
      refreshReview();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    const rows = brands ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((b) =>
      b.canonical_brand.toLowerCase().includes(q) ||
      b.brand_key.includes(q) ||
      (b.aliases ?? []).some((a) => a.toLowerCase().includes(q))
    );
  }, [brands, search]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-brand-kb"] });
  };

  async function verify(table: string, fact: Fact) {
    setBusyId(fact.id);
    try {
      await api(`/api/admin/brand-knowledge/${table}/${fact.id}`, "PATCH", { verified: true });
      toast.success("Marked verified");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(table: string, fact: Fact) {
    const editable: Record<string, unknown> = {};
    for (const col of EDITABLE[table] ?? []) editable[col] = fact[col];
    setEditTarget({ table, fact });
    setEditJson(JSON.stringify(editable, null, 2));
  }

  async function saveEdit() {
    if (!editTarget) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editJson);
    } catch {
      toast.error("Invalid JSON");
      return;
    }
    setSaving(true);
    try {
      await api(
        `/api/admin/brand-knowledge/${editTarget.table}/${editTarget.fact.id}`,
        "PATCH",
        parsed,
      );
      toast.success("Saved");
      setEditTarget(null);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!deleteTarget) return;
    try {
      await api(
        `/api/admin/brand-knowledge/${deleteTarget.table}/${deleteTarget.fact.id}`,
        "DELETE",
      );
      toast.success("Deleted");
      setDeleteTarget(null);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function factTitle(section: typeof CHILD_SECTIONS[number], fact: Fact): string {
    return String(fact[section.title] ?? "(untitled)");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BookMarked}
        title="Brand Knowledge"
        subtitle="Verify and correct the brand/style knowledge that grounds garment identification. Every fact shows its source and confidence."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_1fr]">
        {/* Brand list */}
        <Card>
          <CardHeader className="pb-3">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground"
              />
              <Input
                aria-label="Search brands"
                className="pl-8"
                placeholder="Search brands…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="max-h-[70dvh] space-y-1 overflow-auto">
            {/* US-2555: error first. Below, a failed read fell through to the
                "No brands." line — an outage reading as an empty knowledge
                base, on the page an operator would check to confirm it. */}
            {isError
              ? (
                <ErrorState
                  title="Couldn't load the brand list"
                  description="The knowledge base is unchanged — this is a read failure."
                  onRetry={() => void refetch()}
                  retrying={isFetching}
                />
              )
              : isLoading
              ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)
              : filtered.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelected(b.brand_key)}
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-accent ${
                    selected === b.brand_key ? "border-primary bg-accent" : ""
                  }`}
                >
                  <span className="font-medium">{b.canonical_brand}</span>
                  <span className="flex items-center gap-1">
                    {b.verified ? <ShieldCheck className="h-3.5 w-3.5 text-primary" /> : null}
                    <span className="text-xs text-muted-foreground">
                      {Object.values(b.counts).reduce((a, n) => a + n, 0)}
                    </span>
                  </span>
                </button>
              ))}
            {!isLoading && !isError && filtered.length === 0
              ? <p className="text-sm text-muted-foreground">No brands.</p>
              : null}
          </CardContent>
        </Card>

        {/* Detail */}
        <div className="space-y-4">
          {!selected
            ? <Card><CardContent className="py-16 text-center text-muted-foreground">Select a brand to review its knowledge.</CardContent></Card>
            : detailError
            ? (
              <Card>
                <ErrorState
                  title="Couldn't load this brand"
                  description="Its facts are unchanged — we just could not read them."
                  onRetry={() => void refetchDetail()}
                  retrying={detailFetching}
                />
              </Card>
            )
            : detailLoading
            ? <Skeleton className="h-64 w-full" />
            : detail
            ? (
              <>
                {/* Pack preview */}
                {detail.pack
                  ? (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">
                          Pack preview{" "}
                          <Badge variant="outline">source: {detail.pack.source}</Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-wrap gap-2 text-sm text-muted-foreground">
                        <span>{detail.pack.styles.length} styles</span>
                        <span>· {detail.pack.decoders.length} decoders</span>
                        <span>· {detail.pack.colorways.length} colorways</span>
                        <span>· {detail.pack.sizingCharts.length} size charts</span>
                        <span className="w-full text-xs">
                          This is exactly what the extractor receives for this brand.
                        </span>
                      </CardContent>
                    </Card>
                  )
                  : null}

                {CHILD_SECTIONS.map((section) => {
                  const facts = detail[section.key] as Fact[];
                  return (
                    <Card key={section.key}>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">
                          {section.label} ({facts.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {facts.length === 0
                          ? <p className="text-sm text-muted-foreground">None seeded yet.</p>
                          : facts.map((fact) => (
                            <div
                              key={fact.id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                            >
                              <span className="font-medium">{factTitle(section, fact)}</span>
                              <span className="flex items-center gap-2">
                                <ConfidenceBadge c={fact.confidence} />
                                <VerifiedBadge v={fact.verified} />
                                {safeHref(fact.source_url)
                                  ? (
                                    <a
                                      href={safeHref(fact.source_url) ?? undefined}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-xs text-primary underline"
                                    >
                                      source
                                    </a>
                                  )
                                  : <span className="text-xs text-destructive">no source</span>}
                                {!fact.verified
                                  ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={busyId === fact.id}
                                      onClick={() => verify(section.table, fact)}
                                    >
                                      {busyId === fact.id
                                        ? <Loader2 className="h-3 w-3 animate-spin" />
                                        : "Verify"}
                                    </Button>
                                  )
                                  : null}
                                <Button size="icon" variant="ghost" aria-label="Edit fact" onClick={() => openEdit(section.table, fact)}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label="Delete fact"
                                  onClick={() => setDeleteTarget({ table: section.table, fact })}
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                </Button>
                              </span>
                            </div>
                          ))}
                      </CardContent>
                    </Card>
                  );
                })}
              </>
            )
            : null}
        </div>
      </div>

      {/* US-2785: the nightly brand crawl spends a shared eBay allowance, and
          until now spent it invisibly. Codes per listing is the number that
          decides more brands versus fewer brands crawled deeper. Read-only:
          nothing here starts, stops or re-runs a crawl. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                Style-code discovery crawl
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                How far the nightly brand crawl has walked each brand's live eBay
                listings, and what it got back. A brand is exhausted when its
                cursor wrapped or several passes found nothing new.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={crawling !== null}
              onClick={() => void runCrawl()}
            >
              {crawling === "__rotation__" ? "Crawling…" : "Run tonight's batch now"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {crawlError
            ? (
              <ErrorState
                title="Couldn't load the crawl state"
                description="Nothing was changed — this is a read failure."
                onRetry={() => void refetchCrawl()}
                retrying={crawlFetching}
              />
            )
            : crawlLoading
            ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)
            : (crawl?.brands ?? []).length === 0
            ? (
              <p className="text-sm text-muted-foreground">
                No brands in the knowledge base yet, so there is nothing to
                crawl.
              </p>
            )
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Brand</th>
                      <th className="py-2 pr-4 font-medium">Last crawled</th>
                      <th className="py-2 pr-4 text-right font-medium">Depth</th>
                      <th className="py-2 pr-4 text-right font-medium">Scanned</th>
                      <th className="py-2 pr-4 text-right font-medium">Codes</th>
                      <th className="py-2 pr-4 text-right font-medium">
                        Codes / listing
                      </th>
                      <th className="py-2 font-medium">State</th>
                      <th className="py-2 pl-4 font-medium sr-only">Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(crawl?.brands ?? []).map((row) => (
                      <tr key={row.brand_key} className="border-t">
                        <td className="py-2 pr-4">{row.brand}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {row.last_run_at
                            ? new Date(row.last_run_at).toLocaleDateString()
                            : "never"}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.page_offset.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.listings_seen.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.codes_found.toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {row.codes_per_listing === null
                            ? "—"
                            : row.codes_per_listing.toFixed(3)}
                        </td>
                        <td className="py-2">
                          {row.last_run_at === null
                            ? (
                              <Badge variant="outline">queued</Badge>
                            )
                            : row.exhausted
                            ? <Badge variant="secondary">exhausted</Badge>
                            : <Badge variant="outline">crawling</Badge>}
                        </td>
                        <td className="py-2 pl-4 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={crawling !== null}
                            onClick={() => void runCrawl(row.brand_key)}
                          >
                            {crawling === row.brand_key ? "Crawling…" : "Crawl now"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </CardContent>
      </Card>

      {/* US-2693: what the machine LEARNED, and the two verbs an admin has for
          it. Ordered by what needs a human — disagreement first, then thin
          evidence — because a list sorted by brand is a list nobody opens
          twice. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Learned style codes</CardTitle>
          <p className="text-sm text-muted-foreground">
            Names the market sweep and seller corrections produced for a tag
            code. Promote one to permanent brand knowledge, or reject it.
            Conflicts and thinly-evidenced names are listed first.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {reviewError
            ? (
              <ErrorState
                title="Couldn't load the review queue"
                description="Nothing was changed — this is a read failure."
                onRetry={() => void refetchReview()}
                retrying={reviewFetching}
              />
            )
            : reviewLoading
            ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)
            : (review?.items ?? []).length === 0
            ? (
              <p className="text-sm text-muted-foreground">
                Nothing learned yet. The sweep fills this as it resolves codes.
              </p>
            )
            : (review?.items ?? []).map((item) => (
              <div
                key={`${item.brandKey}-${item.styleCodeNorm}`}
                className="rounded-md border px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{item.styleCodeRaw}</span>
                  <span className="text-sm text-muted-foreground">
                    {item.brandKey}
                  </span>
                  {item.conflicting
                    ? <Badge variant="destructive">Sources disagree</Badge>
                    : null}
                  {!item.conflicting && item.resolved &&
                      item.resolved.supporting < 3
                    ? <Badge variant="outline">Thin evidence</Badge>
                    : null}
                  {!item.resolved
                    ? <Badge variant="outline">No name left</Badge>
                    : null}
                </div>
                <div className="mt-2 space-y-1">
                  {item.candidates.map((cand, i) => (
                    <div
                      key={cand.id ?? `${item.styleCodeNorm}-${i}`}
                      className="flex flex-wrap items-center gap-2 text-sm"
                    >
                      <span className={cand.rejected ? "line-through text-muted-foreground" : ""}>
                        {cand.name}
                      </span>
                      <Badge variant="secondary">{cand.source}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {cand.supporting} supporting
                      </span>
                      {/* safeHref returns null for a scheme it will not
                          render; drop the link rather than emit a dead anchor. */}
                      {safeHref(cand.evidenceUrl)
                        ? (
                          <a
                            className="text-xs underline"
                            href={safeHref(cand.evidenceUrl) ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            evidence
                          </a>
                        )
                        : null}
                      {cand.id && !cand.rejected
                        ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === cand.id}
                              onClick={() => openPromote(cand)}
                            >
                              {busyId === cand.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <BadgeCheck className="h-3 w-3" />}
                              Promote
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busyId === cand.id}
                              onClick={() => void rejectName(cand.id!)}
                            >
                              <CircleAlert className="h-3 w-3" />
                              Reject
                            </Button>
                          </>
                        )
                        : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          {review?.truncated
            ? (
              <p className="text-sm text-muted-foreground">
                More codes exist than this page scanned. Filter by brand to see
                the rest.
              </p>
            )
            : null}
        </CardContent>
      </Card>

      {/* US-2693: promote dialog */}
      <Dialog
        open={!!promoteTarget}
        onOpenChange={(o) => !o && setPromoteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Promote to brand knowledge</DialogTitle>
            <DialogDescription>
              This writes a permanent brand_styles row and marks it verified.
              A source is required — the knowledge base rejects a fact without
              one.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="promote-name">Style name</Label>
              <p id="promote-name" className="text-sm">{promoteTarget?.name}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="promote-source">Source URL</Label>
              <Input
                id="promote-source"
                placeholder="https://…"
                value={promoteSource}
                onChange={(e) => setPromoteSource(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="promote-department">Department (optional)</Label>
              <Input
                id="promote-department"
                placeholder="Men, Women, Unisex…"
                value={promoteDepartment}
                onChange={(e) => setPromoteDepartment(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPromoteTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!promoteSource.trim() || busyId === promoteTarget?.id}
              onClick={() => void confirmPromote()}
            >
              {busyId === promoteTarget?.id
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <BadgeCheck className="h-4 w-4" />}
              Promote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit {editTarget?.table}</DialogTitle>
            <DialogDescription>
              Editable fields as JSON. brand_key is not editable. confidence must be
              0–1; verified must be true/false.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bk-fields">Fields</Label>
            <Textarea
              id="bk-fields"
              className="min-h-[280px] font-mono text-xs"
              value={editJson}
              onChange={(e) => setEditJson(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this fact?</DialogTitle>
            <DialogDescription>
              This permanently removes the row from {deleteTarget?.table}. This cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={doDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
