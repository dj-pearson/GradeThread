import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Sparkles, ExternalLink, Trash2, Loader2, FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  CONTENT_PRODUCTS,
  CONTENT_STATUSES,
  CONTENT_STATUS_LABELS,
  PRODUCT_LABELS,
} from "@/lib/constants";
import {
  useBlogPosts,
  useCreateBlogPost,
  useDeleteBlogPost,
  useSchedulerTick,
} from "@/hooks/use-content";
import type { ContentProduct } from "@/types/database";

export function BlogListPage() {
  const [status, setStatus] = useState<string>("");
  const [product, setProduct] = useState<string>("");
  const { data: posts = [], isLoading } = useBlogPosts({
    status: status || undefined,
    product_focus: product || undefined,
  });
  const confirm = useConfirm();
  const create = useCreateBlogPost();
  const del = useDeleteBlogPost();
  const tick = useSchedulerTick();
  const navigate = useNavigate();
  const [newPostOpen, setNewPostOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const createPost = async () => {
    const title = newTitle.trim();
    if (!title) return;
    const post = await create.mutateAsync({
      title,
      product_focus: (product as ContentProduct) || "both",
    });
    setNewPostOpen(false);
    setNewTitle("");
    navigate(`/admin/content/blog/editor/${post.id}`);
  };

  return (
    <div className="space-y-4">
      <SEO title="Blog" noindex />
      <PageHeader
        title="Blog"
        subtitle="SEO-targeted articles. Generate from the topic bank or write your own."
        actions={
          <>
            <Button
              variant="outline"
              disabled={tick.isPending}
              onClick={() => tick.mutate({ force_surface: "blog" })}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {tick.isPending ? "Generating…" : "Generate next"}
            </Button>
            <Button
              onClick={() => {
                setNewTitle("");
                setNewPostOpen(true);
              }}
              disabled={create.isPending}
            >
              <Plus className="mr-2 h-4 w-4" /> New post
            </Button>
          </>
        }
      />

      <Dialog open={newPostOpen} onOpenChange={setNewPostOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New post</DialogTitle>
            <DialogDescription>
              Give the post a working title. You can refine it in the editor.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="new-post-title">Working title</Label>
            <Input
              id="new-post-title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTitle.trim() && !create.isPending) {
                  e.preventDefault();
                  void createPost();
                }
              }}
              placeholder="e.g. How to grade a vintage denim jacket"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewPostOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void createPost()}
              disabled={!newTitle.trim() || create.isPending}
            >
              {create.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create post
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Filter posts by status" className="w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {CONTENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {CONTENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={product} onValueChange={setProduct}>
          <SelectTrigger aria-label="Filter posts by product" className="w-44">
            <SelectValue placeholder="All products" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All products</SelectItem>
            {CONTENT_PRODUCTS.map((p) => (
              <SelectItem key={p} value={p}>
                {PRODUCT_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(status || product) && (
          <Button
            variant="ghost"
            onClick={() => {
              setStatus("");
              setProduct("");
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="p-4">
            <LoadingRegion label="Loading posts">
              <SkeletonRows rows={6} />
            </LoadingRegion>
          </CardContent>
        </Card>
      ) : posts.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={FileText}
              title="No posts yet"
              description="Create your first blog post to get started."
              action={{
                label: "New post",
                icon: Plus,
                onClick: () => {
                  setNewTitle("");
                  setNewPostOpen(true);
                },
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Title</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Focus</th>
                  <th className="p-3">Primary keyword</th>
                  <th className="p-3">Updated</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-b hover:bg-muted/50">
                    <td className="p-3">
                      <Link
                        to={`/admin/content/blog/editor/${p.id}`}
                        className="font-medium hover:underline"
                      >
                        {p.title || <em>(untitled)</em>}
                      </Link>
                      {p.excerpt && (
                        <p className="line-clamp-1 text-xs text-muted-foreground">
                          {p.excerpt}
                        </p>
                      )}
                    </td>
                    <td className="p-3">
                      <Badge
                        variant={
                          p.status === "published"
                            ? "default"
                            : p.status === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {CONTENT_STATUS_LABELS[p.status]}
                      </Badge>
                    </td>
                    <td className="p-3">{PRODUCT_LABELS[p.product_focus]}</td>
                    <td className="p-3 font-mono text-xs">
                      {p.primary_keyword || "—"}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {new Date(p.updated_at).toLocaleString()}
                    </td>
                    <td className="p-3 text-right">
                      {p.status === "published" && (
                        <a
                          href={`/blog/${p.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mr-2 inline-flex"
                          title="View live"
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`View ${p.title || p.slug} live`}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        title="Delete"
                        aria-label={`Delete ${p.title || p.slug}`}
                        disabled={del.isPending}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Delete "${p.title}"?`,
                              description:
                                "This permanently removes the post and its content. This can't be undone.",
                              confirmLabel: "Delete post",
                              destructive: true,
                            })
                          ) {
                            del.mutate(p.id);
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
