import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
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

export function AdminBrandKnowledgePage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<{ table: string; fact: Fact } | null>(null);
  const [editJson, setEditJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ table: string; fact: Fact } | null>(null);

  const { data: brands, isLoading } = useQuery({
    queryKey: ["admin-brand-kb"],
    queryFn: async (): Promise<BrandRow[]> => (await api("/api/admin/brand-knowledge")).brands ?? [],
    staleTime: 30 * 1000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["admin-brand-kb", selected],
    queryFn: async (): Promise<BrandDetail> => await api(`/api/admin/brand-knowledge/${selected}`),
    enabled: !!selected,
  });

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
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <BookMarked className="h-6 w-6" /> Brand Knowledge
        </h1>
        <p className="text-muted-foreground">
          Verify and correct the brand/style knowledge that grounds garment
          identification. Every fact shows its source and confidence.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_1fr]">
        {/* Brand list */}
        <Card>
          <CardHeader className="pb-3">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search brands…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="max-h-[70dvh] space-y-1 overflow-auto">
            {isLoading
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
            {!isLoading && filtered.length === 0
              ? <p className="text-sm text-muted-foreground">No brands.</p>
              : null}
          </CardContent>
        </Card>

        {/* Detail */}
        <div className="space-y-4">
          {!selected
            ? <Card><CardContent className="py-16 text-center text-muted-foreground">Select a brand to review its knowledge.</CardContent></Card>
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
                                {fact.source_url
                                  ? (
                                    <a
                                      href={fact.source_url}
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
                                <Button size="icon" variant="ghost" onClick={() => openEdit(section.table, fact)}>
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
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
            <Label>Fields</Label>
            <Textarea
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
