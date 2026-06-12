import { useState } from "react";
import { Link } from "react-router-dom";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles } from "lucide-react";
import {
  CONTENT_PRODUCTS,
  CONTENT_STATUSES,
  CONTENT_STATUS_LABELS,
  PRODUCT_LABELS,
} from "@/lib/constants";
import { useSchedulerTick, useSocialPosts } from "@/hooks/use-content";

export function SocialListPage() {
  const [status, setStatus] = useState<string>("");
  const [product, setProduct] = useState<string>("");
  const { data: posts = [], isLoading } = useSocialPosts({
    status: status || undefined,
    product_focus: product || undefined,
  });
  const tick = useSchedulerTick();

  return (
    <div className="space-y-4">
      <SEO title="Social" noindex />
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Social</h1>
          <p className="text-sm text-muted-foreground">
            Paired long-format + short-format posts. CTAs drive back to the site.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={tick.isPending}
          onClick={() => tick.mutate({ force_surface: "social" })}
        >
          <Sparkles className="mr-2 h-4 w-4" />
          {tick.isPending ? "Generating…" : "Generate next"}
        </Button>
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
          <CardContent className="p-4">
            <LoadingRegion label="Loading social posts">
              <SkeletonRows rows={6} />
            </LoadingRegion>
          </CardContent>
        </Card>
      ) : posts.length === 0 ? (
        <Card>
          <CardContent className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <span>No social posts yet.</span>
            <span>
              Promote a topic from the{" "}
              <Link
                to="/admin/content/topics"
                className="underline underline-offset-2"
              >
                Topic Bank
              </Link>{" "}
              to start.
            </span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {posts.map((p) => (
            <Link
              key={p.id}
              to={`/admin/content/social/editor/${p.id}`}
              className="block"
            >
              <Card className="h-full transition hover:border-primary/50">
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <Badge
                      variant={
                        p.status === "published" ? "default" : "secondary"
                      }
                    >
                      {CONTENT_STATUS_LABELS[p.status]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {PRODUCT_LABELS[p.product_focus]}
                    </span>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground">
                        Long
                      </p>
                      <p className="line-clamp-4 whitespace-pre-wrap text-sm">
                        {p.long_body || <em>(empty)</em>}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground">
                        Short ({p.short_body.length}/280)
                      </p>
                      <p className="line-clamp-4 whitespace-pre-wrap text-sm">
                        {p.short_body || <em>(empty)</em>}
                      </p>
                    </div>
                  </div>
                  {p.hashtags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {p.hashtags.map((h) => (
                        <span
                          key={h}
                          className="text-xs text-muted-foreground"
                        >
                          #{h}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
