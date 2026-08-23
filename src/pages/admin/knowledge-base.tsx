import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { MarkdownPreview } from "@/components/admin/markdown-preview";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
import { ClickableRow } from "@/components/clickable-row";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BookOpen,
  Plus,
  Search,
  Loader2,
  AlertTriangle,
  Eye,
  EyeOff,
  History,
  Save,
} from "lucide-react";
import { toast } from "sonner";

// US-840: admin authoring surface for the support knowledge base — the single
// control surface for the corpus the AI Support Assistant may ever speak from.
// List/search articles, create/edit with markdown preview, set category +
// audience, publish/unpublish, and view per-article revision history. Every read
// + write goes through the admin-MFA-gated /api/admin/knowledge-base endpoints
// (service-role server writes; the SPA has no write policy on support_kb_*).

const CATEGORIES = [
  "grading",
  "pricing",
  "plans",
  "photos",
  "disputes",
  "flipdesk",
  "billing",
  "account",
  "getting_started",
] as const;
type Category = (typeof CATEGORIES)[number];

const AUDIENCES = ["public", "subscriber"] as const;
type Audience = (typeof AUDIENCES)[number];

type StatusFilter = "all" | "published" | "draft";

interface ArticleListRow {
  id: string;
  slug: string;
  title: string;
  category: Category;
  audience: Audience;
  version: number;
  is_published: boolean;
  updated_at: string;
}

interface Article extends ArticleListRow {
  body_md: string;
  created_at: string;
}

interface Revision {
  id: string;
  version: number;
  title: string;
  body_md: string;
  edited_by: string | null;
  edited_by_email: string | null;
  created_at: string;
}

interface FormState {
  slug: string;
  title: string;
  body_md: string;
  category: Category;
  audience: Audience;
  is_published: boolean;
}

const EMPTY_FORM: FormState = {
  slug: "",
  title: "",
  body_md: "",
  category: "getting_started",
  audience: "public",
  is_published: false,
};

const categoryLabel = (c: string) =>
  c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : "";
}

export function AdminKnowledgeBasePage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  // US-2335: ids for the editor form's two labelled selects.
  const formCategoryId = useId();
  const formAudienceId = useId();
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState<"all" | Category>("all");
  const [audience, setAudience] = useState<"all" | Audience>("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  // Editor state: null = closed, "new" = create, otherwise the article id.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [tab, setTab] = useState("edit");

  // Debounce the free-text search so each keystroke doesn't refetch.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // ── List ────────────────────────────────────────────────────────────────
  const listQuery = useQuery({
    queryKey: ["admin-kb", "list", debounced, category, audience, status],
    queryFn: async (): Promise<ArticleListRow[]> => {
      const params = new URLSearchParams();
      if (debounced) params.set("q", debounced);
      if (category !== "all") params.set("category", category);
      if (audience !== "all") params.set("audience", audience);
      if (status !== "all") params.set("status", status);
      const qs = params.toString();
      const res = await edgeFetch(
        `/api/admin/knowledge-base${qs ? `?${qs}` : ""}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load articles");
      return (json.articles ?? []) as ArticleListRow[];
    },
    staleTime: 30 * 1000,
  });

  // ── Open article for editing ──────────────────────────────────────────────
  const articleQuery = useQuery({
    queryKey: ["admin-kb", "article", editing],
    enabled: !!editing && editing !== "new",
    queryFn: async (): Promise<Article> => {
      const res = await edgeFetch(`/api/admin/knowledge-base/${editing}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load article");
      return json.article as Article;
    },
  });

  const revisionsQuery = useQuery({
    queryKey: ["admin-kb", "revisions", editing],
    enabled: !!editing && editing !== "new" && tab === "history",
    queryFn: async (): Promise<Revision[]> => {
      const res = await edgeFetch(
        `/api/admin/knowledge-base/${editing}/revisions`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load history");
      return (json.revisions ?? []) as Revision[];
    },
  });

  // Hydrate the form when an existing article loads.
  useEffect(() => {
    if (editing && editing !== "new" && articleQuery.data) {
      const a = articleQuery.data;
      setForm({
        slug: a.slug,
        title: a.title,
        body_md: a.body_md,
        category: a.category,
        audience: a.audience,
        is_published: a.is_published,
      });
    }
  }, [editing, articleQuery.data]);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setTab("edit");
    setEditing("new");
  };
  const openEdit = (id: string) => {
    setTab("edit");
    setEditing(id);
  };
  const closeEditor = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin-kb", "list"] });
    if (editing && editing !== "new") {
      await queryClient.invalidateQueries({
        queryKey: ["admin-kb", "article", editing],
      });
      await queryClient.invalidateQueries({
        queryKey: ["admin-kb", "revisions", editing],
      });
    }
  };

  // ── Save (create or update) ───────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async (): Promise<Article> => {
      const isNew = editing === "new";
      const res = await edgeFetch(
        isNew
          ? "/api/admin/knowledge-base"
          : `/api/admin/knowledge-base/${editing}`,
        {
          method: isNew ? "POST" : "PATCH",
          json: {
            slug: form.slug || undefined,
            title: form.title,
            body_md: form.body_md,
            category: form.category,
            audience: form.audience,
            is_published: form.is_published,
          },
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      return json.article as Article;
    },
    onSuccess: async (article) => {
      toast.success(`Saved “${article.title}” (v${article.version}).`);
      await invalidate();
      if (editing === "new") setEditing(article.id);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Save failed");
    },
  });

  // Publish/unpublish toggle — a metadata-only PATCH (no version bump).
  const publishMutation = useMutation({
    mutationFn: async (next: boolean): Promise<Article> => {
      const res = await edgeFetch(`/api/admin/knowledge-base/${editing}`, {
        method: "PATCH",
        json: { is_published: next },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Update failed");
      return json.article as Article;
    },
    onSuccess: async (article) => {
      setForm((f) => ({ ...f, is_published: article.is_published }));
      toast.success(article.is_published ? "Published." : "Unpublished.");
      await invalidate();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Update failed");
    },
  });

  const articles = listQuery.data ?? [];
  const isNew = editing === "new";
  const editorLoading = !isNew && articleQuery.isLoading;
  const canSave = form.title.trim().length > 0 && !saveMutation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BookOpen}
        title="Support Knowledge Base"
        subtitle="The corpus the AI support assistant speaks from. Only published articles are retrievable by the bot."
        actions={
          <Button onClick={openNew}>
            <Plus className="mr-1 h-4 w-4" />
            New article
          </Button>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search
            aria-hidden="true"
            className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          />
          <Input
            aria-label="Search articles"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search articles…"
            className="pl-8"
          />
        </div>
        <Select value={category} onValueChange={(v) => setCategory(v as typeof category)}>
          {/* US-2335: the placeholder is not a name. Unset this announces
              "Category"; once chosen it announces the category — the control
              renames itself as you use it. */}
          <SelectTrigger className="w-44" aria-label="Filter by category">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {categoryLabel(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={audience} onValueChange={(v) => setAudience(v as typeof audience)}>
          <SelectTrigger className="w-40" aria-label="Filter by audience">
            <SelectValue placeholder="Audience" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All audiences</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="subscriber">Subscriber</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-36" aria-label="Filter by status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {listQuery.isLoading
            ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            )
            : listQuery.isError
            ? (
              <div className="flex items-center gap-2 p-6 text-sm text-brand-red-text">
                <AlertTriangle className="h-4 w-4" />
                {(listQuery.error as Error)?.message ?? "Failed to load."}
              </div>
            )
            : articles.length === 0
            ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No articles match this view.
              </p>
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title / slug</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Audience</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Ver.</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {articles.map((a) => (
                    <ClickableRow
                      key={a.id}
                      onActivate={() => openEdit(a.id)}
                      activateLabel={`Edit ${a.title}`}
                    >
                      <TableCell className="max-w-md">
                        <div className="font-medium">{a.title}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {a.slug}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {categoryLabel(a.category)}
                      </TableCell>
                      <TableCell className="text-sm capitalize">
                        {a.audience}
                      </TableCell>
                      <TableCell>
                        {a.is_published
                          ? (
                            <Badge
                              variant="secondary"
                              className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            >
                              Published
                            </Badge>
                          )
                          : (
                            <Badge variant="secondary" className="bg-muted text-muted-foreground">
                              Draft
                            </Badge>
                          )}
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        v{a.version}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {fmtDate(a.updated_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                        aria-label={`Edit ${a.title}`}
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(a.id);
                          }}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    </ClickableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      {/* Editor */}
      <Sheet open={!!editing} onOpenChange={(open) => !open && closeEditor()}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-2xl">
          <SheetHeader className="space-y-1 border-b pb-4">
            <SheetTitle>{isNew ? "New article" : "Edit article"}</SheetTitle>
            <SheetDescription>
              {isNew
                ? "Create a knowledge base article."
                : `v${articleQuery.data?.version ?? "…"} · ${
                  form.is_published ? "published" : "draft"
                }`}
            </SheetDescription>
          </SheetHeader>

          {editorLoading
            ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )
            : (
              <Tabs
                value={tab}
                onValueChange={setTab}
                className="flex flex-1 flex-col overflow-hidden"
              >
                <TabsList className="mx-4 mt-3 self-start">
                  <TabsTrigger value="edit">Edit</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                  {!isNew && <TabsTrigger value="history">History</TabsTrigger>}
                </TabsList>

                {/* Edit */}
                <TabsContent
                  value="edit"
                  className="flex-1 space-y-4 overflow-y-auto p-4"
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="kb-title">Title</Label>
                    <Input
                      id="kb-title"
                      value={form.title}
                      maxLength={200}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, title: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="kb-slug">Slug</Label>
                    <Input
                      id="kb-slug"
                      value={form.slug}
                      placeholder="auto-from-title if left blank"
                      className="font-mono text-sm"
                      onChange={(e) =>
                        setForm((f) => ({ ...f, slug: e.target.value }))}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={formCategoryId}>Category</Label>
                      <Select
                        value={form.category}
                        onValueChange={(v) =>
                          setForm((f) => ({ ...f, category: v as Category }))}
                      >
                        <SelectTrigger id={formCategoryId}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {categoryLabel(c)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={formAudienceId}>Audience</Label>
                      <Select
                        value={form.audience}
                        onValueChange={(v) =>
                          setForm((f) => ({ ...f, audience: v as Audience }))}
                      >
                        <SelectTrigger id={formAudienceId}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AUDIENCES.map((a) => (
                            <SelectItem key={a} value={a} className="capitalize">
                              {a}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="kb-body">Body (markdown)</Label>
                    <Textarea
                      id="kb-body"
                      value={form.body_md}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, body_md: e.target.value }))}
                      className="min-h-[320px] font-mono text-sm"
                      placeholder="Write the article in markdown…"
                    />
                  </div>
                </TabsContent>

                {/* Preview */}
                <TabsContent
                  value="preview"
                  className="flex-1 overflow-y-auto p-4"
                >
                  <h2 className="mb-3 text-xl font-bold">
                    {form.title || "Untitled"}
                  </h2>
                  <MarkdownPreview source={form.body_md} />
                </TabsContent>

                {/* History */}
                {!isNew && (
                  <TabsContent
                    value="history"
                    className="flex-1 overflow-y-auto p-4"
                  >
                    {revisionsQuery.isLoading
                      ? (
                        <div className="flex items-center justify-center py-8">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                      )
                      : (revisionsQuery.data ?? []).length === 0
                      ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">
                          No revision history.
                        </p>
                      )
                      : (
                        <ul className="space-y-3">
                          {(revisionsQuery.data ?? []).map((r) => (
                            <li
                              key={r.id}
                              className="rounded-lg border p-3 text-sm"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1.5 font-medium">
                                  <History className="h-3.5 w-3.5 text-muted-foreground" />
                                  Version {r.version}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {fmtDate(r.created_at)}
                                </span>
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                {r.title}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                Edited by {r.edited_by_email ?? "system"}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                  </TabsContent>
                )}

                {/* Footer actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4">
                  {!isNew
                    ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={publishMutation.isPending}
                        onClick={() => publishMutation.mutate(!form.is_published)}
                      >
                        {form.is_published
                          ? <EyeOff className="mr-1 h-4 w-4" />
                          : <Eye className="mr-1 h-4 w-4" />}
                        {form.is_published ? "Unpublish" : "Publish"}
                      </Button>
                    )
                    : <span />}
                  <Button
                    size="sm"
                    disabled={!canSave}
                    onClick={() => saveMutation.mutate()}
                  >
                    {saveMutation.isPending
                      ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      : <Save className="mr-1 h-4 w-4" />}
                    {isNew ? "Create" : "Save changes"}
                  </Button>
                </div>
              </Tabs>
            )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
