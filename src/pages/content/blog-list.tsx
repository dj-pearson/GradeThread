import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Sparkles, ExternalLink, Trash2 } from "lucide-react";
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
  const create = useCreateBlogPost();
  const del = useDeleteBlogPost();
  const tick = useSchedulerTick();
  const navigate = useNavigate();

  const newPost = async () => {
    const title = window.prompt("Working title?");
    if (!title?.trim()) return;
    const post = await create.mutateAsync({
      title: title.trim(),
      product_focus: (product as ContentProduct) || "both",
    });
    navigate(`/dashboard/content/blog/editor/${post.id}`);
  };

  return (
    <div className="space-y-4">
      <SEO title="Blog" noindex />
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Blog</h1>
          <p className="text-sm text-muted-foreground">
            SEO-targeted articles. Generate from the topic bank or write your
            own.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={tick.isPending}
            onClick={() => tick.mutate({ force_surface: "blog" })}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {tick.isPending ? "Generating…" : "Generate next"}
          </Button>
          <Button onClick={newPost} disabled={create.isPending}>
            <Plus className="mr-2 h-4 w-4" /> New post
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
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
          <SelectTrigger className="w-44">
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
          <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </CardContent>
        </Card>
      ) : posts.length === 0 ? (
        <Card>
          <CardContent className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <span>No posts yet.</span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
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
                        to={`/dashboard/content/blog/editor/${p.id}`}
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
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        </a>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        title="Delete"
                        onClick={() => {
                          if (window.confirm(`Delete "${p.title}"?`)) {
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
