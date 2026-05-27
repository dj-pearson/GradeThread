import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Save, Send } from "lucide-react";
import {
  CONTENT_PRODUCTS,
  CONTENT_STATUS_LABELS,
  PRODUCT_LABELS,
  SOCIAL_LONG_LIMIT,
  SOCIAL_SHORT_LIMIT,
} from "@/lib/constants";
import {
  usePublishSocialPost,
  useSocialPost,
  useUpdateSocialPost,
} from "@/hooks/use-content";
import type { ContentProduct } from "@/types/database";
import { toast } from "sonner";

export function SocialEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: post, isLoading } = useSocialPost(id ?? null);

  if (!id) return null;
  if (isLoading || !post) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  return (
    <SocialEditorInner
      postId={id}
      initial={{
        product_focus: post.product_focus,
        status: post.status,
        long_body: post.long_body,
        short_body: post.short_body,
        hashtags: post.hashtags,
        cta_url: post.cta_url,
      }}
      onBack={() => navigate("/dashboard/content/social")}
    />
  );
}

function SocialEditorInner({
  postId,
  initial,
  onBack,
}: {
  postId: string;
  initial: {
    product_focus: ContentProduct;
    status: string;
    long_body: string;
    short_body: string;
    hashtags: string[];
    cta_url: string | null;
  };
  onBack: () => void;
}) {
  const update = useUpdateSocialPost(postId);
  const publish = usePublishSocialPost(postId);

  const [productFocus, setProductFocus] = useState<ContentProduct>(
    initial.product_focus,
  );
  const [longBody, setLongBody] = useState(initial.long_body);
  const [shortBody, setShortBody] = useState(initial.short_body);
  const [hashtags, setHashtags] = useState(initial.hashtags.join(", "));
  const [ctaUrl, setCtaUrl] = useState(initial.cta_url ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Debounced autosave of body fields. Hashtags/cta save on Save click.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(async () => {
      setSaving(true);
      try {
        await update.mutateAsync({
          long_body: longBody,
          short_body: shortBody,
        });
        setDirty(false);
      } finally {
        setSaving(false);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [longBody, shortBody, dirty, update]);

  const saveMeta = async () => {
    await update.mutateAsync({
      product_focus: productFocus,
      hashtags: hashtags
        .split(",")
        .map((s) => s.trim().toLowerCase().replace(/^#/, ""))
        .filter(Boolean),
      cta_url: ctaUrl || null,
    });
    toast.success("Saved.");
  };

  const runPublish = async () => {
    if (!window.confirm("Publish this social post now?")) return;
    await saveMeta();
    await publish.mutateAsync();
  };

  const shortOver = shortBody.length > SOCIAL_SHORT_LIMIT;
  const longOver = longBody.length > SOCIAL_LONG_LIMIT;

  return (
    <div className="space-y-4">
      <SEO title="Social post" />
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              initial.status === "published" ? "default" : "secondary"
            }
          >
            {CONTENT_STATUS_LABELS[
              initial.status as keyof typeof CONTENT_STATUS_LABELS
            ] ?? initial.status}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {saving ? "Saving…" : "Saved"}
          </span>
          <Button
            size="sm"
            onClick={runPublish}
            disabled={
              publish.isPending ||
              (!longBody.trim() && !shortBody.trim()) ||
              longOver ||
              shortOver
            }
          >
            <Send className="mr-2 h-4 w-4" />
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Long (LinkedIn / Facebook)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={longBody}
              onChange={(e) => {
                setLongBody(e.target.value);
                setDirty(true);
              }}
              rows={16}
              placeholder="Hook line.

Then the body..."
            />
            <p
              className={`mt-2 text-xs ${
                longOver ? "text-red-600" : "text-muted-foreground"
              }`}
            >
              {longBody.length}/{SOCIAL_LONG_LIMIT}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Short (X / Threads)</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={shortBody}
              onChange={(e) => {
                setShortBody(e.target.value);
                setDirty(true);
              }}
              rows={16}
              placeholder="One punchy thought + link."
            />
            <p
              className={`mt-2 text-xs ${
                shortOver ? "text-red-600" : "text-muted-foreground"
              }`}
            >
              {shortBody.length}/{SOCIAL_SHORT_LIMIT}
              {shortOver && " — too long for X"}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Meta</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div>
            <Label htmlFor="sp-product">Product focus</Label>
            <Select
              value={productFocus}
              onValueChange={(v) => setProductFocus(v as ContentProduct)}
            >
              <SelectTrigger id="sp-product">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_PRODUCTS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PRODUCT_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="sp-cta">CTA URL</Label>
            <Input
              id="sp-cta"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://gradethread.com/?utm_source=linkedin&utm_medium=social&utm_campaign=..."
            />
          </div>
          <div className="md:col-span-3">
            <Label htmlFor="sp-hashtags">Hashtags (comma-separated)</Label>
            <Input
              id="sp-hashtags"
              value={hashtags}
              onChange={(e) => setHashtags(e.target.value)}
              placeholder="reselling, thrifting, ebay"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="outline" onClick={saveMeta} disabled={update.isPending}>
          <Save className="mr-2 h-4 w-4" /> Save meta
        </Button>
      </div>
    </div>
  );
}
