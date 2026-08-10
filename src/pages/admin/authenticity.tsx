import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  Users,
} from "lucide-react";
import { toast } from "sonner";

// US-2146/2147/2148/2131: the operator console for brand authenticity.
//
// Five backends existed as routes with no surface. The framing choices here are
// deliberate and load-bearing:
//
//  • The gate banner is the FIRST thing on the page, because an ungated prompt
//    is currently serving real users (paid add-on, buyer check, and an
//    unauthenticated public endpoint) and that fact should not be three clicks
//    deep.
//  • Accuracy NEVER shows a single number. The two error directions harm
//    different people and only one is compensable, so they are always displayed
//    side by side — a combined "accuracy" figure stays flat while a version
//    stops missing fakes and starts flagging genuine items.

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

const BASE = "/api/admin/grading/authenticity";

interface GateVersion {
  prompt_version: string;
  model: string;
  gated: boolean;
  last_passing_run_at: string | null;
  agreement_rate: number | null;
  reason: string | null;
}
interface Accuracy {
  reviewed: number;
  agreement_rate: number;
  false_negatives: number;
  false_negative_rate: number;
  false_positives: number;
  false_positive_rate: number;
}
interface BrandCoverage {
  total: number;
  authentic: number;
  counterfeit: number;
  usable: boolean;
}
interface SellerSignal {
  seller_id: string;
  assessed: number;
  model_flagged: number;
  confirmed_counterfeit: number;
  confirmed_authentic: number;
  peak_cluster: number;
  clustered: boolean;
}
interface TellCandidate {
  brand_key: string;
  category: string;
  observations: number;
  discrimination: number;
  leans: string;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// ── Gate banner ─────────────────────────────────────────────────────────────

function GateBanner() {
  const { data, isLoading } = useQuery({
    queryKey: ["authenticity_gate"],
    queryFn: async (): Promise<{ all_gated: boolean; versions: GateVersion[] }> =>
      await api(`${BASE}/gate`),
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data) return null;

  if (data.all_gated) {
    return (
      <div className="rounded-lg border border-emerald-600/40 bg-emerald-50 px-4 py-3 dark:bg-emerald-950/30">
        <div className="flex items-center gap-2 font-medium text-emerald-800 dark:text-emerald-400">
          <ShieldCheck className="h-5 w-5" />
          Every live authenticity prompt has passed the eval gate
        </div>
        <ul className="mt-2 space-y-1 text-xs text-emerald-900/80 dark:text-emerald-300/80">
          {data.versions.map((v) => (
            <li key={v.prompt_version}>
              <span className="font-mono">{v.prompt_version}</span> on{" "}
              <span className="font-mono">{v.model}</span>
              {v.agreement_rate != null && ` — ${pct(v.agreement_rate)} agreement`}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-600/50 bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-400">
        <ShieldAlert className="h-5 w-5" />
        Authenticity is serving UNGATED
      </div>
      <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-300/80">
        These prompt versions are producing verdicts for real users — including on
        a public endpoint — without having passed an accuracy gate. The gate
        cannot pass until the golden set has labelled cases for the brands being
        assessed.
      </p>
      <ul className="mt-2 space-y-1 text-xs text-amber-900/80 dark:text-amber-300/80">
        {data.versions.filter((v) => !v.gated).map((v) => (
          <li key={v.prompt_version}>
            <span className="font-mono">{v.prompt_version}</span> — {v.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Accuracy ────────────────────────────────────────────────────────────────

function ErrorDirectionCard({
  title,
  who,
  count,
  rate,
  tone,
}: {
  title: string;
  who: string;
  count: number;
  rate: number;
  tone: "buyer" | "seller";
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle
            className={`h-4 w-4 ${tone === "buyer" ? "text-red-600" : "text-amber-600"}`}
          />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{who}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{pct(rate)}</div>
        <div className="text-xs text-muted-foreground">{count} of the reviewed set</div>
      </CardContent>
    </Card>
  );
}

function AccuracyTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["authenticity_accuracy"],
    queryFn: async (): Promise<{
      overall: Accuracy;
      by_prompt_version: Record<string, Accuracy>;
      by_brand: Record<string, Accuracy>;
      observations_considered: number;
    }> => await api(`${BASE}/accuracy`),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;

  if (data.overall.reviewed === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No resolved authenticity reviews yet. Accuracy appears once reviewers
          start recording outcomes — those reviews are also the cheapest source of
          golden-set cases.
        </CardContent>
      </Card>
    );
  }

  const o = data.overall;
  return (
    <div className="space-y-4">
      {/* Never one number: these two are not interchangeable. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <ErrorDirectionCard
          title="Fakes we called authentic"
          who="A buyer received a counterfeit we vouched for. This is what the gate fails on."
          count={o.false_negatives}
          rate={o.false_negative_rate}
          tone="buyer"
        />
        <ErrorDirectionCard
          title="Genuine items we flagged"
          who="A seller's real item was publicly flagged. Nobody reimburses this."
          count={o.false_positives}
          rate={o.false_positive_rate}
          tone="seller"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">By prompt version</CardTitle>
          <CardDescription className="text-xs">
            A regression from one version disappears in a pooled number.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {Object.entries(data.by_prompt_version).map(([version, a]) => (
            <div key={version} className="flex items-center justify-between text-sm">
              <span className="font-mono text-xs">{version}</span>
              <span className="text-xs text-muted-foreground">
                {a.reviewed} reviewed · {pct(a.agreement_rate)} agree ·{" "}
                <span className="text-red-600">{a.false_negatives} FN</span> ·{" "}
                <span className="text-amber-600">{a.false_positives} FP</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Golden set ──────────────────────────────────────────────────────────────

function GoldenSetTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["authenticity_cases"],
    queryFn: async (): Promise<{
      cases: { id: string; label: string; brand_key: string; expected_label: string; is_active: boolean }[];
      coverage: { brands: Record<string, BrandCoverage>; usable_brands: number; total_active: number };
    }> => await api(`${BASE}/cases`),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data) return null;

  const brands = Object.entries(data.coverage.brands);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Coverage</CardTitle>
          <CardDescription className="text-xs">
            A brand is usable only with BOTH an authentic and a counterfeit case —
            a perfect score over genuine-only examples cannot demonstrate the one
            error the gate exists to catch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 text-sm">
            <span className="font-semibold">{data.coverage.usable_brands}</span> usable
            brand{data.coverage.usable_brands === 1 ? "" : "s"} ·{" "}
            {data.coverage.total_active} active case
            {data.coverage.total_active === 1 ? "" : "s"}
          </div>
          {brands.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No cases yet. Bulk-import with the template at{" "}
              <span className="font-mono text-xs">docs/authenticity-golden-set-template.json</span>.
            </p>
          ) : (
            <div className="space-y-1">
              {brands.map(([key, c]) => (
                <div key={key} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs">{key}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {c.authentic} authentic · {c.counterfeit} counterfeit
                    {c.usable
                      ? <Badge variant="secondary">usable</Badge>
                      : <Badge variant="outline">one-sided</Badge>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Cases</CardTitle>
          <CardDescription className="text-xs">
            Cases are retired, never deleted — a shrinking golden set is how a
            failing gate gets made to pass.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {data.cases.slice(0, 100).map((c) => (
            <div key={c.id} className="flex items-center justify-between text-sm">
              <span className="truncate">{c.label}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs">
                <Badge variant={c.expected_label === "counterfeit" ? "destructive" : "secondary"}>
                  {c.expected_label}
                </Badge>
                {!c.is_active && <Badge variant="outline">retired</Badge>}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Tell candidates ─────────────────────────────────────────────────────────

function TellCandidatesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["authenticity_tell_candidates"],
    queryFn: async (): Promise<{
      promotable: TellCandidate[];
      emerging: TellCandidate[];
      observations_considered: number;
    }> => await api(`${BASE}/tell-candidates`),
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) return null;

  const Row = ({ c }: { c: TellCandidate }) => (
    <div className="flex items-center justify-between text-sm">
      <span>
        <span className="font-mono text-xs">{c.brand_key}</span>
        <span className="mx-2 text-muted-foreground">·</span>
        {c.category}
      </span>
      <span className="text-xs text-muted-foreground">
        {c.observations} obs · {pct(c.discrimination)} directional · leans {c.leans}
      </span>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Ready to write up</CardTitle>
          <CardDescription className="text-xs">
            Frequency is evidence, not authority — these are proposals. Write the
            actual tell in Brand Knowledge; nothing here edits the KB.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {data.promotable.length === 0
            ? <p className="text-sm text-muted-foreground">Nothing has cleared both bars yet.</p>
            : data.promotable.map((c) => <Row key={`${c.brand_key}-${c.category}`} c={c} />)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Emerging</CardTitle>
          <CardDescription className="text-xs">
            Not yet enough observations, or not directional enough to separate real
            from fake. Shown so “a few more reviews and this qualifies” is visible.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {data.emerging.slice(0, 30).map((c) => <Row key={`${c.brand_key}-${c.category}`} c={c} />)}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Decoder contradictions (US-2138 AC7) ────────────────────────────────────
//
// A verdict a DETERMINISTIC decoder capped. Without this an operator sees a low
// confidence and cannot tell whether the model was unsure or a decoder proved
// the code impossible — and those call for opposite responses.
//
// ⚠ OPERATOR-ONLY, deliberately. Each row names the rule that caught the item,
// which is what someone would need to write a code that passes next time. It is
// not mirrored onto the seller's submission page, where the verdict already
// appears in prose.

interface DecoderContradictionRow {
  grade_report_id: string;
  submission_id: string;
  created_at: string;
  verdict: string | null;
  verdict_confidence: number | null;
  brand: string | null;
  flags: Array<{ code: string; message: string }>;
}

function DecoderContradictionsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["authenticity_decoder_contradictions"],
    queryFn: async (): Promise<{
      contradictions: DecoderContradictionRow[];
      truncated: boolean;
    }> => await api(`${BASE}/decoder-contradictions`),
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  const rows = data?.contradictions ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deterministic decoder contradictions</CardTitle>
          <CardDescription>
            The code on the tag is impossible — a fact about the code, not a read of
            a photo. These cap the verdict rather than being weighed by the model.
            Operator-only: the rule that fired is not shown to the seller.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0
            ? (
              <p className="text-sm text-muted-foreground">
                None recorded. Only one rule can fire today — a code dating to the
                future. The other, a code predating the brand, needs a founding
                year the brand knowledge base does not carry yet.
              </p>
            )
            : (
              <ul className="divide-y">
                {rows.map((r) => (
                  <li key={r.grade_report_id} className="space-y-1 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant="destructive">{r.verdict ?? "no verdict"}</Badge>
                      {r.brand ? <span className="font-medium">{r.brand}</span> : null}
                      <span className="text-muted-foreground">
                        confidence{" "}
                        {r.verdict_confidence === null
                          ? "—"
                          : r.verdict_confidence.toFixed(2)}
                      </span>
                      <span className="text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {r.flags.map((f, i) => (
                        <li key={i}>
                          <span className="font-mono">{f.code}</span> — {f.message}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          {data?.truncated
            ? (
              <p className="mt-3 text-xs text-muted-foreground">
                ⚠ Showing the newest rows only — the read hit its cap, so this is a
                sample rather than the whole history.
              </p>
            )
            : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Sellers ─────────────────────────────────────────────────────────────────

function SellersTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["authenticity_sellers"],
    queryFn: async (): Promise<{ sellers: SellerSignal[]; clustered: number; considered: number }> =>
      await api(`${BASE}/sellers`),
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="h-4 w-4" />
          Sellers by confirmed findings
        </CardTitle>
        <CardDescription className="text-xs">
          Clustering matters more than totals: several confirmed counterfeits in a
          short window is one consignment, which is the shape a per-period claims
          budget absorbs worst. Only HUMAN-confirmed outcomes count toward a
          cluster — an ungated model cannot manufacture one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {data.sellers.length === 0
          ? <p className="text-sm text-muted-foreground">No assessed sellers yet.</p>
          : data.sellers.slice(0, 50).map((s) => (
            <div key={s.seller_id} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs">{s.seller_id.slice(0, 8)}…</span>
                {s.clustered && <Badge variant="destructive">clustered ×{s.peak_cluster}</Badge>}
              </span>
              <span className="text-xs text-muted-foreground">
                {s.assessed} assessed · {s.confirmed_counterfeit} confirmed fake ·{" "}
                {s.confirmed_authentic} cleared
              </span>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export function AdminAuthenticityPage() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);

  async function runEval() {
    setRunning(true);
    try {
      const r = await api(`${BASE}/eval`, "POST", {});
      toast[r.passed ? "success" : "warning"](
        r.passed
          ? `Gate PASSED — ${pct(r.agreement_rate)} agreement over ${r.cases_total} cases.`
          : `Gate FAILED — ${r.dangerous_misses} dangerous miss(es), ${pct(r.agreement_rate)} agreement.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["authenticity_gate"] });
    } catch (err) {
      // The expected failure is an empty golden set — a setup state, not a bug.
      toast.error(err instanceof Error ? err.message : "Eval run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Authenticity"
        subtitle="The brand-authenticity pass: its accuracy gate, the golden set that certifies it, and what reviewers have found."
        actions={
          <Button onClick={() => void runEval()} disabled={running}>
            {running
              ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
            Run eval gate
          </Button>
        }
      />

      <GateBanner />

      <Tabs defaultValue="accuracy">
        <TabsList>
          <TabsTrigger value="accuracy">
            <TrendingDown className="mr-1.5 h-4 w-4" />
            Accuracy
          </TabsTrigger>
          <TabsTrigger value="golden">Golden set</TabsTrigger>
          <TabsTrigger value="tells">Tell candidates</TabsTrigger>
          <TabsTrigger value="sellers">Sellers</TabsTrigger>
          <TabsTrigger value="decoders">Decoder flags</TabsTrigger>
        </TabsList>
        <TabsContent value="accuracy" className="mt-4"><AccuracyTab /></TabsContent>
        <TabsContent value="golden" className="mt-4"><GoldenSetTab /></TabsContent>
        <TabsContent value="tells" className="mt-4"><TellCandidatesTab /></TabsContent>
        <TabsContent value="sellers" className="mt-4"><SellersTab /></TabsContent>
        <TabsContent value="decoders" className="mt-4"><DecoderContradictionsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
