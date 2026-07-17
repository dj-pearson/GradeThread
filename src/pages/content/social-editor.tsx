import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Film, Hash, Image as ImageIcon, RefreshCw, Save, Send, Sparkles, Trash2, Upload } from "lucide-react";
import {
  CONTENT_PRODUCTS,
  CONTENT_STATUS_LABELS,
  PRODUCT_LABELS,
  SOCIAL_LONG_LIMIT,
  SOCIAL_PLATFORM_CHAR_LIMITS,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_SHORT_LIMIT,
} from "@/lib/constants";
import {
  useAttachSocialVideo,
  useClearSocialVideo,
  useGenerateSocialPost,
  usePublishSocialPost,
  useSetSocialCard,
  useSocialPost,
  useSocialVariants,
  useSuggestHashtags,
  useUpdateSocialPost,
  useUpdateSocialVariant,
} from "@/hooks/use-content";
import type {
  ContentProduct,
  SocialPlatform,
  SocialPlatformVariantRow,
} from "@/types/database";
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
        asset_image_url: post.asset_image_url,
        media_type: post.media_type,
        video_url: post.video_url,
      }}
      onBack={() => navigate("/admin/content/social")}
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
    asset_image_url: string | null;
    media_type: "image" | "video";
    video_url: string | null;
  };
  onBack: () => void;
}) {
  const confirm = useConfirm();
  const update = useUpdateSocialPost(postId);
  const publish = usePublishSocialPost(postId);
  const generate = useGenerateSocialPost(postId);
  const suggest = useSuggestHashtags(postId);

  const [productFocus, setProductFocus] = useState<ContentProduct>(
    initial.product_focus,
  );
  const [longBody, setLongBody] = useState(initial.long_body);
  const [shortBody, setShortBody] = useState(initial.short_body);
  const [hashtags, setHashtags] = useState(initial.hashtags.join(", "));
  const [ctaUrl, setCtaUrl] = useState(initial.cta_url ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Pending body-autosave timer, so an explicit Save can cancel it and stay the
  // single in-flight write (US-798).
  const bodyTimerRef = useRef<number | undefined>(undefined);

  // Debounced autosave of body fields. Hashtags/cta save on Save click.
  useEffect(() => {
    if (!dirty) return;
    const t = window.setTimeout(async () => {
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
    bodyTimerRef.current = t;
    return () => window.clearTimeout(t);
  }, [longBody, shortBody, dirty, update]);

  const saveMeta = async () => {
    // Cancel any pending body autosave so this explicit Save is the single
    // in-flight write, and fold the latest body fields into it (US-798).
    if (bodyTimerRef.current !== undefined) {
      window.clearTimeout(bodyTimerRef.current);
      bodyTimerRef.current = undefined;
    }
    await update.mutateAsync({
      long_body: longBody,
      short_body: shortBody,
      product_focus: productFocus,
      hashtags: hashtags
        .split(",")
        .map((s) => s.trim().toLowerCase().replace(/^#/, ""))
        .filter(Boolean),
      cta_url: ctaUrl || null,
    });
    setDirty(false);
    toast.success("Saved.");
  };

  const runPublish = async () => {
    if (
      !(await confirm({
        title: "Publish this social post now?",
        description: "It will be sent to the connected channel immediately.",
        confirmLabel: "Publish post",
      }))
    )
      return;
    await saveMeta();
    await publish.mutateAsync();
  };

  const runGenerate = async () => {
    const result = await generate.mutateAsync({});
    if (result?.post) {
      setLongBody(result.post.long_body);
      setShortBody(result.post.short_body);
      setHashtags((result.post.hashtags ?? []).join(", "));
      setCtaUrl(result.post.cta_url ?? "");
      setDirty(false);
    }
  };

  const shortOver = shortBody.length > SOCIAL_SHORT_LIMIT;
  const longOver = longBody.length > SOCIAL_LONG_LIMIT;

  return (
    <div className="space-y-4">
      <SEO title="Social post" noindex />
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
            variant="outline"
            size="sm"
            onClick={runGenerate}
            disabled={generate.isPending}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {generate.isPending ? "Generating…" : "Generate"}
          </Button>
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
                longOver ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
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
                shortOver ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
              }`}
            >
              {shortBody.length}/{SOCIAL_SHORT_LIMIT}
              {shortOver && " — too long for X"}
            </p>
          </CardContent>
        </Card>
      </div>

      <PlatformVariantsSection postId={postId} />

      <VideoSection
        postId={postId}
        mediaType={initial.media_type}
        videoUrl={initial.video_url}
      />

      <SocialCardSection
        postId={postId}
        assetImageUrl={initial.asset_image_url}
        productFocus={productFocus}
      />

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
            <div className="flex gap-2">
              <Input
                id="sp-hashtags"
                value={hashtags}
                onChange={(e) => setHashtags(e.target.value)}
                placeholder="reselling, thrifting, ebay"
              />
              <Button
                type="button"
                variant="outline"
                disabled={
                  suggest.isPending || (!longBody.trim() && !shortBody.trim())
                }
                onClick={async () => {
                  // Save any unsaved body edits so the suggester sees them.
                  if (dirty) {
                    await update.mutateAsync({
                      long_body: longBody,
                      short_body: shortBody,
                    });
                    setDirty(false);
                  }
                  const suggested = await suggest.mutateAsync();
                  if (!suggested || suggested.length === 0) return;
                  const existing = new Set(
                    hashtags
                      .split(",")
                      .map((s) => s.trim().toLowerCase().replace(/^#/, ""))
                      .filter(Boolean),
                  );
                  const merged = [
                    ...Array.from(existing),
                    ...suggested.filter((h) => !existing.has(h)),
                  ];
                  setHashtags(merged.join(", "));
                }}
              >
                <Hash className="mr-2 h-4 w-4" />
                {suggest.isPending ? "…" : "Suggest"}
              </Button>
            </div>
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

// US-871: branded social card. When a post has no asset of its own, publish
// auto-fills a branded /og/social/card image per platform. Here an admin can
// (re)generate that branded card or override it with a custom upload (validated
// + EXIF-stripped server-side).
function SocialCardSection({
  postId,
  assetImageUrl,
  productFocus,
}: {
  postId: string;
  assetImageUrl: string | null;
  productFocus: ContentProduct;
}) {
  const setCard = useSetSocialCard(postId);
  const [current, setCurrent] = useState<string | null>(assetImageUrl);
  const fileRef = useRef<HTMLInputElement>(null);

  const regenerate = async () => {
    const res = await setCard.mutateAsync({ ratio: "landscape", kind: "quote" });
    setCurrent(res.url);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const res = await setCard.mutateAsync({ image_base64: dataUrl });
    setCurrent(res.url);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Social card</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={setCard.isPending}
            onClick={regenerate}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {setCard.isPending ? "Working…" : "Regenerate card"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={setCard.isPending}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" /> Override
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={onFile}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {current ? (
          <img
            src={current}
            alt="Social card preview"
            className="max-h-64 w-auto rounded-md border"
          />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ImageIcon className="h-4 w-4" />
            No card yet — publish will auto-fill a branded card per platform, or
            set one now.
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {productFocus === "flipdesk"
            ? "FlipDesk"
            : productFocus === "both"
              ? "GradeThread + FlipDesk"
              : "GradeThread"}{" "}
          branding · auto-generated in each network's aspect ratio. Override
          uploads are validated and stripped of metadata.
        </p>
      </CardContent>
    </Card>
  );
}

// Video distribution: attach a clip so this post publishes as a video. The
// clip uploads to the public content-videos bucket and its URL fans out to the
// video-native networks (TikTok / Instagram Reels / Facebook video) through the
// same Make.com publish webhook. When a video is attached the post publishes as
// a video; remove it to fall back to the branded still card.
function VideoSection({
  postId,
  mediaType,
  videoUrl,
}: {
  postId: string;
  mediaType: "image" | "video";
  videoUrl: string | null;
}) {
  const attach = useAttachSocialVideo(postId);
  const clear = useClearSocialVideo(postId);
  const [current, setCurrent] = useState<string | null>(
    mediaType === "video" ? videoUrl : null,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const res = await attach.mutateAsync(file);
    // Cache-bust so the freshly uploaded clip shows immediately.
    setCurrent(`${res.url}?t=${Date.now()}`);
  };

  const onRemove = async () => {
    await clear.mutateAsync();
    setCurrent(null);
  };

  const busy = attach.isPending || clear.isPending;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Video</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            {attach.isPending ? "Uploading…" : current ? "Replace" : "Upload video"}
          </Button>
          {current && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRemove}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {clear.isPending ? "Removing…" : "Remove"}
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/x-m4v"
            className="hidden"
            onChange={onFile}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {current ? (
          <video
            src={current}
            controls
            className="max-h-72 w-auto rounded-md border"
          />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Film className="h-4 w-4" />
            No video attached — this post publishes as a still card. Upload a
            clip to publish it as a video.
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Fans out to TikTok, Instagram Reels, and Facebook video via the Make.com
          publish webhook. mp4, mov, m4v, or webm. The social card above is used as
          the cover/poster.
        </p>
      </CardContent>
    </Card>
  );
}

// US-870: per-platform tailored variants. Each network gets its own editable
// body + hashtags with a live character counter against that platform's limit.
// Generated by the AI "Generate" call; the editor can tweak each before publish.
function PlatformVariantsSection({ postId }: { postId: string }) {
  const { data: variants, isLoading } = useSocialVariants(postId);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Platform variants</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </CardContent>
      </Card>
    );
  }

  if (!variants || variants.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Platform variants</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No per-platform variants yet. Click <strong>Generate</strong> to
            create tailored posts for each enabled platform (X, LinkedIn,
            Facebook, Threads, Pinterest, Instagram).
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {variants.map((v) => (
        <PlatformVariantCard key={v.platform} postId={postId} variant={v} />
      ))}
    </div>
  );
}

function PlatformVariantCard({
  postId,
  variant,
}: {
  postId: string;
  variant: SocialPlatformVariantRow;
}) {
  const updateVariant = useUpdateSocialVariant(postId);
  const platform = variant.platform as SocialPlatform;
  const limit = variant.char_limit ?? SOCIAL_PLATFORM_CHAR_LIMITS[platform];

  const [body, setBody] = useState(variant.body);
  const [hashtags, setHashtags] = useState(variant.hashtags.join(", "));
  const [dirty, setDirty] = useState(false);

  const over = body.length > limit;

  const save = async () => {
    await updateVariant.mutateAsync({
      platform,
      body,
      hashtags: hashtags
        .split(",")
        .map((s) => s.trim().toLowerCase().replace(/^#/, ""))
        .filter(Boolean),
    });
    setDirty(false);
    toast.success(`${SOCIAL_PLATFORM_LABELS[platform]} variant saved.`);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          {SOCIAL_PLATFORM_LABELS[platform]}
        </CardTitle>
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty || updateVariant.isPending || over}
          onClick={save}
        >
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setDirty(true);
          }}
          rows={8}
          placeholder={`Tailored ${SOCIAL_PLATFORM_LABELS[platform]} post…`}
        />
        <p
          className={`text-xs ${
            over ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
          }`}
        >
          {body.length}/{limit}
          {over && ` — too long for ${SOCIAL_PLATFORM_LABELS[platform]}`}
        </p>
        <div>
          <Label htmlFor={`var-tags-${platform}`} className="text-xs">
            Hashtags
          </Label>
          <Input
            id={`var-tags-${platform}`}
            value={hashtags}
            onChange={(e) => {
              setHashtags(e.target.value);
              setDirty(true);
            }}
            placeholder="reselling, thrifting"
          />
        </div>
      </CardContent>
    </Card>
  );
}
