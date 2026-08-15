import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { ExternalLink, LifeBuoy, Lock, Plus, Trash2, Users } from "lucide-react";
import {
  useCreateHelpArticle,
  useDeleteHelpArticle,
  useHelpArticles,
  useHelpCategories,
} from "@/hooks/use-help-center";
import {
  HELP_STATUS_LABELS,
  HELP_STATUSES,
  HELP_VISIBILITIES,
  HELP_VISIBILITY_LABELS,
  helpArticlePath,
  type HelpVisibility,
} from "@/types/help-center";

// Help Center article list (US-2574). The admin surface, so the columns are the
// ones an author is deciding between: which shelf it sits on, who can read it,
// and whether it is live. Visibility gets an icon as well as a word because it
// is the field with a consequence — "Internal" and "Public" must not be
// distinguishable only by reading carefully.

const VISIBILITY_ICON: Record<HelpVisibility, typeof Lock> = {
  public: ExternalLink,
  members: Users,
  internal: Lock,
};

const VISIBILITY_VARIANT: Record<
  HelpVisibility,
  "default" | "secondary" | "outline" | "destructive"
> = {
  public: "secondary",
  members: "outline",
  internal: "destructive",
};

export function HelpListPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data: articles = [], isLoading } = useHelpArticles();
  const { data: categories = [] } = useHelpCategories();
  const create = useCreateHelpArticle();
  const del = useDeleteHelpArticle();

  const [categoryFilter, setCategoryFilter] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState("");

  const categoryTitle = useMemo(() => {
    const map = new Map(categories.map((c) => [c.key, c.title]));
    return (key: string) => map.get(key) ?? key;
  }, [categories]);

  const categorySlug = useMemo(() => {
    const map = new Map(categories.map((c) => [c.key, c.slug]));
    return (key: string) => map.get(key) ?? key;
  }, [categories]);

  const rows = articles.filter(
    (a) =>
      (!categoryFilter || a.category_key === categoryFilter) &&
      (!visibilityFilter || a.visibility === visibilityFilter) &&
      (!statusFilter || a.status === statusFilter),
  );

  const createArticle = async () => {
    const title = newTitle.trim();
    if (!title || !newCategory) return;
    const article = await create.mutateAsync({ title, category_key: newCategory });
    setNewOpen(false);
    setNewTitle("");
    navigate(`/admin/content/help/editor/${article.id}`);
  };

  const removeArticle = async (id: string, title: string) => {
    const ok = await confirm({
      title: "Delete this article?",
      description: `"${title}" will be removed. Any public URL it had starts returning 404.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) del.mutate(id);
  };

  return (
    <div className="space-y-4">
      <SEO title="Help Center" noindex />
      <PageHeader
        title="Help Center"
        subtitle="Every article, public and private. Visibility decides who reads it and whether Google indexes it."
        actions={
          <Button
            onClick={() => {
              setNewTitle("");
              setNewCategory(categoryFilter || categories[0]?.key || "");
              setNewOpen(true);
            }}
            disabled={create.isPending || categories.length === 0}
          >
            <Plus className="mr-2 h-4 w-4" /> New article
          </Button>
        }
      />

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New article</DialogTitle>
            <DialogDescription>
              It starts as a draft on the shelf you pick. Nothing is visible until you publish it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="new-help-title">Title</Label>
              <Input
                id="new-help-title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTitle.trim() && newCategory && !create.isPending) {
                    e.preventDefault();
                    void createArticle();
                  }
                }}
                placeholder="e.g. What the photo requirements are"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-help-category">Category</Label>
              <Select value={newCategory} onValueChange={setNewCategory}>
                <SelectTrigger id="new-help-category">
                  <SelectValue placeholder="Pick a shelf" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => void createArticle()}
              disabled={!newTitle.trim() || !newCategory || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap gap-2">
        <Select value={categoryFilter || "all"} onValueChange={(v) => setCategoryFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-56" aria-label="Filter by category">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={visibilityFilter || "all"}
          onValueChange={(v) => setVisibilityFilter(v === "all" ? "" : v)}
        >
          <SelectTrigger className="w-44" aria-label="Filter by visibility">
            <SelectValue placeholder="Any visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any visibility</SelectItem>
            {HELP_VISIBILITIES.map((v) => (
              <SelectItem key={v} value={v}>
                {HELP_VISIBILITY_LABELS[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-40" aria-label="Filter by status">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {HELP_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {HELP_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingRegion label="Loading articles" className="p-4">
              <SkeletonRows rows={6} />
            </LoadingRegion>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              title={articles.length === 0 ? "No articles yet" : "Nothing matches those filters"}
              description={
                articles.length === 0
                  ? "Write the first one. Getting Started is the shelf most people hit first."
                  : "Clear a filter to see the rest."
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const Icon = VISIBILITY_ICON[a.visibility];
                  return (
                    <TableRow
                      key={a.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/admin/content/help/editor/${a.id}`)}
                    >
                      <TableCell>
                        <div className="font-medium">{a.title}</div>
                        <div className="text-sm text-muted-foreground">
                          {a.visibility === "public" && a.status === "published"
                            ? helpArticlePath(categorySlug(a.category_key), a.slug)
                            : `/${a.slug}`}
                        </div>
                      </TableCell>
                      <TableCell>{categoryTitle(a.category_key)}</TableCell>
                      <TableCell>
                        <Badge variant={VISIBILITY_VARIANT[a.visibility]}>
                          <Icon className="mr-1 h-3 w-3" />
                          {HELP_VISIBILITY_LABELS[a.visibility]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={a.status === "published" ? "default" : "outline"}>
                          {HELP_STATUS_LABELS[a.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${a.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeArticle(a.id, a.title);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
