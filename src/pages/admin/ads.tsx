import { lazy, Suspense, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Megaphone,
  Loader2,
  Plus,
  Sparkles,
  Save,
  Download,
  Archive,
  RotateCcw,
  Tag,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { SEO } from "@/components/seo";
import { cn } from "@/lib/utils";
import { edgeFetch } from "@/lib/edge-fetch";
import { ErrorState } from "@/components/ui/error-state";

// US-1699: lazy so recharts + the dashboard load only when the tab is opened.
const AdsCommandCenter = lazy(() =>
  import("./ads-command-center").then((m) => ({ default: m.AdsCommandCenter }))
);

// US-1073: AI Ad Copy Studio. Generates Google Ads RSA headlines/descriptions
// and Apple Search Ads keyword/creative sets grounded in the keyword library +
// brand voice, saves generations, and exports them (CSV / Google Ads Editor).
//
// Admin-only — behind <AdminRoute> at the route level; emits noindex via <SEO>.

type AdPlatform = "google_ads" | "apple_search_ads";

const PLATFORM_LABEL: Record<AdPlatform, string> = {
  google_ads: "Google Ads",
  apple_search_ads: "Apple Search Ads",
};

interface KeywordTheme {
  id: string;
  theme: string;
  platform: string;
  keywords: string[] | null;
  pillar: string | null;
  notes: string | null;
  is_active: boolean;
}

interface AdLine {
  text: string;
  chars: number;
}

interface GoogleAdsPayload {
  headlines: AdLine[];
  descriptions: AdLine[];
}
interface AppleSearchAdsPayload {
  keywords: { exact: string[]; broad: string[] };
  creative: AdLine[];
}
type AdPayload = GoogleAdsPayload | AppleSearchAdsPayload;

interface GenerateResult {
  platform: AdPlatform;
  payload: AdPayload;
  sourceKeywords: string[];
  meta: {
    model_used: string;
    prompt_version: string;
    dropped: number;
  };
}

interface AdCreative {
  id: string;
  platform: AdPlatform;
  name: string | null;
  source_keywords: string[];
  payload: AdPayload;
  model: string | null;
  created_at: string;
}

// US-2803: `includeArchived` reaches ?include_archived=1, which the route has
// implemented since it was written and which nothing ever passed. Without it
// an archived theme is invisible AND unreachable — see the restore route.
function useThemes(includeArchived: boolean) {
  return useQuery<KeywordTheme[]>({
    queryKey: ["admin_ads_themes", includeArchived],
    queryFn: async () => {
      const res = await edgeFetch(
        `/api/admin/ads/themes${includeArchived ? "?include_archived=1" : ""}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load keyword themes.");
      return (json.themes ?? []) as KeywordTheme[];
    },
  });
}

function useCreatives() {
  return useQuery<AdCreative[]>({
    queryKey: ["admin_ads_creatives"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/ads/creatives");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load saved creatives.");
      return (json.creatives ?? []) as AdCreative[];
    },
  });
}

function isGoogle(p: AdPayload): p is GoogleAdsPayload {
  return (p as GoogleAdsPayload).headlines !== undefined;
}

async function downloadExport(id: string, format: "csv" | "ads_editor") {
  try {
    const res = await edgeFetch(`/api/admin/ads/creatives/${id}/export?format=${format}`);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || "Export failed.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id.slice(0, 8)}_${format}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Export failed.");
  }
}

export function AdminAdsPage() {
  const qc = useQueryClient();
  // US-1699: top-level view — Command Center (performance) vs Copy Studio.
  const [view, setView] = useState<"command" | "copy">("command");
  const [platform, setPlatform] = useState<AdPlatform>("google_ads");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [saveName, setSaveName] = useState("");

  // New-theme form.
  const [showNewTheme, setShowNewTheme] = useState(false);
  const [newTheme, setNewTheme] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const [newPillar, setNewPillar] = useState("");
  // US-2803: local, not persisted — a filter that outlives the visit is one
  // somebody forgets is on.
  const [showArchived, setShowArchived] = useState(false);

  const themesQuery = useThemes(showArchived);
  const creativesQuery = useCreatives();

  const visibleThemes = useMemo(
    () =>
      (themesQuery.data ?? []).filter(
        (t) => t.platform === "both" || t.platform === platform,
      ),
    [themesQuery.data, platform],
  );

  function toggleTheme(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const createTheme = useMutation({
    mutationFn: async () => {
      const keywords = newKeywords
        .split(/[\n,]/)
        .map((k) => k.trim())
        .filter(Boolean);
      const res = await edgeFetch("/api/admin/ads/themes", {
        method: "POST",
        json: { theme: newTheme.trim(), platform: "both", keywords, pillar: newPillar.trim() },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not create theme.");
      return json;
    },
    onSuccess: () => {
      toast.success("Keyword theme added.");
      setNewTheme("");
      setNewKeywords("");
      setNewPillar("");
      setShowNewTheme(false);
      qc.invalidateQueries({ queryKey: ["admin_ads_themes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const archiveTheme = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/ads/themes/${id}/archive`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not archive theme.");
      return json;
    },
    onSuccess: () => {
      // Prefix match, so both the filtered and unfiltered lists refresh.
      qc.invalidateQueries({ queryKey: ["admin_ads_themes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const restoreTheme = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/ads/themes/${id}/restore`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not restore theme.");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin_ads_themes"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const generate = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch("/api/admin/ads/generate", {
        method: "POST",
        json: {
          platform,
          theme_ids: [...selectedIds],
          instruction: instruction.trim() || undefined,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Generation failed.");
      return json as GenerateResult;
    },
    onSuccess: (data) => {
      setResult(data);
      if (data.meta.dropped > 0) {
        toast.info(`${data.meta.dropped} variant(s) dropped by char-limit / policy guardrails.`);
      } else {
        toast.success("Ad copy generated.");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!result) throw new Error("Nothing to save.");
      const res = await edgeFetch("/api/admin/ads/creatives", {
        method: "POST",
        json: {
          platform: result.platform,
          name: saveName.trim() || undefined,
          source_theme_ids: [...selectedIds],
          source_keywords: result.sourceKeywords,
          payload: result.payload,
          model: result.meta.model_used,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Save failed.");
      return json;
    },
    onSuccess: () => {
      toast.success("Saved to ad creatives.");
      setSaveName("");
      qc.invalidateQueries({ queryKey: ["admin_ads_creatives"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <SEO title="Ads — Admin" noindex />

      <PageHeader
        icon={Megaphone}
        title="Ads"
        subtitle={
          <>
            Google Ads &amp; Apple Search Ads performance and AI-drafted copy.
          </>
        }
      />

      {/* US-1699: top-level tabs — Command Center (performance) vs Copy Studio. */}
      <Tabs value={view} onValueChange={(v) => setView(v as "command" | "copy")}>
        <TabsList>
          <TabsTrigger value="command">Command Center</TabsTrigger>
          <TabsTrigger value="copy">Copy Studio</TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "command" ? (
        <Suspense
          fallback={<p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}
        >
          <AdsCommandCenter />
        </Suspense>
      ) : (
      <>
      <Tabs value={platform} onValueChange={(v) => { setPlatform(v as AdPlatform); setResult(null); }}>
        <TabsList>
          <TabsTrigger value="google_ads">Google Ads (RSA)</TabsTrigger>
          <TabsTrigger value="apple_search_ads">Apple Search Ads</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ── Keyword themes ── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Keyword themes</CardTitle>
            <CardDescription>
              Select the themes to ground the copy in. Generation uses their keywords as the demand signal.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={showArchived ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowArchived((v) => !v)}
              aria-pressed={showArchived}
            >
              <Archive className="mr-1 h-4 w-4" />
              {showArchived ? "Showing archived" : "Show archived"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowNewTheme((s) => !s)}>
              <Plus className="mr-1 h-4 w-4" /> New theme
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {showNewTheme && (
            <div className="space-y-3 rounded-md border p-4">
              <div className="space-y-1">
                <Label htmlFor="new-theme">Theme name</Label>
                <Input
                  id="new-theme"
                  value={newTheme}
                  onChange={(e) => setNewTheme(e.target.value)}
                  placeholder="e.g. Condition grading for resellers"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-keywords">Keywords (comma or newline separated)</Label>
                <Textarea
                  id="new-keywords"
                  value={newKeywords}
                  onChange={(e) => setNewKeywords(e.target.value)}
                  placeholder="used clothing grade, garment condition report, resale score"
                  rows={3}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-pillar">Pillar (optional)</Label>
                <Input
                  id="new-pillar"
                  value={newPillar}
                  onChange={(e) => setNewPillar(e.target.value)}
                  placeholder="condition-vocabulary"
                />
              </div>
              <Button
                size="sm"
                onClick={() => createTheme.mutate()}
                disabled={!newTheme.trim() || createTheme.isPending}
              >
                {createTheme.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                Add theme
              </Button>
            </div>
          )}

          {/* US-2555: error FIRST. Both branches below key off data that
              react-query leaves undefined on an error, so a failed read used
              to render "No keyword themes yet. Add one above." — an outage
              telling an operator to type their themes in again. */}
          {themesQuery.isError ? (
            <ErrorState
              title="Couldn't load the keyword themes"
              description="Your themes are unchanged — we just could not read them."
              onRetry={() => void themesQuery.refetch()}
              retrying={themesQuery.isFetching}
            />
          ) : themesQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : visibleThemes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No keyword themes for {PLATFORM_LABEL[platform]} yet. Add one above.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {visibleThemes.map((t) => {
                const selected = selectedIds.has(t.id);
                return (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`Select theme: ${t.theme}`}
                    className={cn(
                      "cursor-pointer rounded-md border p-3 transition-colors",
                      selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                    )}
                    onClick={() => toggleTheme(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleTheme(t.id);
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">{t.theme}</span>
                      <div className="flex items-center gap-1">
                        {t.pillar && (
                          <Badge variant="secondary" className="shrink-0 text-xs">
                            <Tag className="mr-1 h-3 w-3" />
                            {t.pillar}
                          </Badge>
                        )}
                        {!t.is_active && (
                          <Badge variant="outline" className="shrink-0 text-xs">
                            Archived
                          </Badge>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (t.is_active) archiveTheme.mutate(t.id);
                            else restoreTheme.mutate(t.id);
                          }}
                          title={t.is_active ? "Archive theme" : "Restore theme"}
                        >
                          {t.is_active ? (
                            <Archive className="h-3.5 w-3.5" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(t.keywords ?? []).slice(0, 6).map((k) => (
                        <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {k}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="instruction">Refinement instruction (optional)</Label>
            <Input
              id="instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. punchier, lead with the free certificate"
            />
          </div>

          <Button
            onClick={() => generate.mutate()}
            disabled={selectedIds.size === 0 || generate.isPending}
          >
            {generate.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Generate {PLATFORM_LABEL[platform]} copy
          </Button>
        </CardContent>
      </Card>

      {/* ── Result ── */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Generated copy</CardTitle>
            <CardDescription>
              {PLATFORM_LABEL[result.platform]} · model {result.meta.model_used}
              {result.meta.dropped > 0 ? ` · ${result.meta.dropped} dropped by guardrails` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isGoogle(result.payload) ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Headlines ({result.payload.headlines.length})</h3>
                  <ul className="space-y-1">
                    {result.payload.headlines.map((h, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm">
                        <span>{h.text}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{h.chars}/30</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Descriptions ({result.payload.descriptions.length})</h3>
                  <ul className="space-y-1">
                    {result.payload.descriptions.map((d, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm">
                        <span>{d.text}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{d.chars}/90</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Exact keywords</h3>
                  <div className="flex flex-wrap gap-1">
                    {result.payload.keywords.exact.map((k) => (
                      <Badge key={k} variant="secondary">{k}</Badge>
                    ))}
                  </div>
                  <h3 className="mb-2 mt-3 text-sm font-semibold">Broad keywords</h3>
                  <div className="flex flex-wrap gap-1">
                    {result.payload.keywords.broad.map((k) => (
                      <Badge key={k} variant="outline">{k}</Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Creative lines</h3>
                  <ul className="space-y-1">
                    {result.payload.creative.map((cline, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-sm">
                        <span>{cline.text}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{cline.chars}/45</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <Separator />
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="save-name">Name (optional)</Label>
                <Input
                  id="save-name"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder="Spring resale push"
                  className="w-64"
                />
              </div>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save generation
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Saved creatives ── */}
      <Card>
        <CardHeader>
          <CardTitle>Saved creatives</CardTitle>
          <CardDescription>Export to CSV or the Google Ads Editor bulk format.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {creativesQuery.isError ? (
            <ErrorState
              title="Couldn't load your saved creatives"
              description="They are still saved — this is a read failure, not a loss."
              onRetry={() => void creativesQuery.refetch()}
              retrying={creativesQuery.isFetching}
            />
          ) : creativesQuery.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (creativesQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved creatives yet.</p>
          ) : (
            (creativesQuery.data ?? []).map((cv) => (
              <div key={cv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{PLATFORM_LABEL[cv.platform]}</Badge>
                    <span className="font-medium">{cv.name || "Untitled"}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {cv.source_keywords.slice(0, 5).join(" · ") || "—"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => downloadExport(cv.id, "csv")}>
                  aria-label={`Download the CSV for ${cv.name || "the untitled conversion"}`}
                    <Download className="mr-1 h-4 w-4" /> CSV
                  </Button>
                  {cv.platform === "google_ads" && (
                    <Button variant="outline" size="sm" onClick={() => downloadExport(cv.id, "ads_editor")}>
                    aria-label={`Open ${cv.name || "the untitled conversion"} in Ads Editor`}
                      <Download className="mr-1 h-4 w-4" /> Ads Editor
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
}
