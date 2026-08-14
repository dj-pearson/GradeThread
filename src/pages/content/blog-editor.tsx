import { useEffect, useRef, useState } from "react";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { dirtyFieldLabels, unsavedSummary } from "@/lib/editor-dirty";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useNavigate, useParams } from "react-router";
import type { Editor as TiptapEditorInstance } from "@tiptap/react";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TiptapEditor } from "@/components/content/tiptap-editor";
import { TiptapToolbar } from "@/components/content/tiptap-toolbar";
import { AiStreamButton } from "@/components/content/ai-stream-button";
import { useContentAiStream } from "@/hooks/use-content-ai-stream";
import {
  ArrowLeft,
  Sparkles,
  Image as ImageIcon,
  Send,
  Save,
  Eye,
} from "lucide-react";
import {
  CONTENT_PRODUCTS,
  CONTENT_STATUS_LABELS,
  PRODUCT_LABELS,
} from "@/lib/constants";
import {
  useBlogAuthors,
  useBlogPost,
  useCreatePreviewLink,
  useGenerateBlogPost,
  useGenerateHero,
  usePublishBlogPost,
  useUpdateBlogPost,
  type TitleSuggestion,
} from "@/hooks/use-content";
import { cn } from "@/lib/utils";
import type { ContentProduct } from "@/types/database";
import { toast } from "sonner";

const TITLE_STYLE_LABELS: Record<TitleSuggestion["style"], string> = {
  question: "Question",
  listicle: "Listicle",
  contrarian: "Contrarian",
};

export function BlogEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: post, isLoading } = useBlogPost(id ?? null);

  if (!id) return null;
  if (isLoading || !post) {
    return (
      <LoadingRegion label="Loading blog post" className="space-y-6">
        <SkeletonRows rows={6} className="space-y-4" />
      </LoadingRegion>
    );
  }

  return (
    <Editor
      key={id}
      postId={id}
      initial={post}
      onBack={() => navigate("/admin/content/blog")}
    />
  );
}

interface BlogPostShape {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body_html: string;
  product_focus: ContentProduct;
  status: string;
  hero_image_url: string | null;
  primary_keyword: string | null;
  secondary_keywords: string[];
  seo_title: string | null;
  seo_description: string | null;
  hero_prompt: string | null;
  reading_time_min: number | null;
  scheduled_for: string | null;
  generated_by: "ai" | "human";
  model_used: string | null;
  tags?: string[];
  // Blog GEO / E-E-A-T fields (US-304).
  author: string | null;
  // Linked author entity (US-874).
  author_id: string | null;
  key_takeaways: string[];
  faqs: { q: string; a: string }[];
}

function Editor({
  postId,
  initial,
  onBack,
}: {
  postId: string;
  initial: BlogPostShape;
  onBack: () => void;
}) {
  const confirm = useConfirm();
  // Local state for inputs the user types into — saved on blur or
  // explicit Save. Body HTML is its own debounced autosave loop.
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState(initial.slug);
  const [excerpt, setExcerpt] = useState(initial.excerpt ?? "");
  const [productFocus, setProductFocus] = useState<ContentProduct>(
    initial.product_focus,
  );
  const [primaryKw, setPrimaryKw] = useState(initial.primary_keyword ?? "");
  const [secondaryKw, setSecondaryKw] = useState(
    initial.secondary_keywords.join(", "),
  );
  const [seoTitle, setSeoTitle] = useState(initial.seo_title ?? "");
  const [seoDescription, setSeoDescription] = useState(
    initial.seo_description ?? "",
  );
  const [heroPrompt, setHeroPrompt] = useState(initial.hero_prompt ?? "");
  const [tags, setTags] = useState((initial.tags ?? []).join(", "));
  // GEO / E-E-A-T (US-304): byline, answer-first takeaways (one per line),
  // and FAQs ("Question | Answer" per line).
  const [author, setAuthor] = useState(initial.author ?? "");
  // US-874: linked author entity. "" → none (legacy byline fallback).
  const [authorId, setAuthorId] = useState(initial.author_id ?? "");
  const [keyTakeaways, setKeyTakeaways] = useState(
    (initial.key_takeaways ?? []).join("\n"),
  );
  const [faqsText, setFaqsText] = useState(
    (initial.faqs ?? []).map((f) => `${f.q} | ${f.a}`).join("\n"),
  );

  const [body, setBody] = useState(initial.body_html);
  // Live status — generation now publishes on completion (safety review is
  // advisory), so the badge must reflect the post-generate/post-publish state
  // rather than the snapshot captured at mount.
  const [status, setStatus] = useState(initial.status);
  const [editor, setEditor] = useState<TiptapEditorInstance | null>(null);
  const lastSavedRef = useRef<string>(initial.body_html);
  // Pending body-autosave timer, so an explicit Save can cancel it and stay the
  // single in-flight write (US-798).
  const bodyTimerRef = useRef<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // US-2536: every field except the body saves on an explicit Save, so all of
  // them live only in React state until then. This is what the server last
  // accepted; the guard below compares it against what is on screen.
  const [savedMeta, setSavedMeta] = useState<Record<string, string>>({
    title: initial.title,
    slug: initial.slug,
    excerpt: initial.excerpt ?? "",
    productFocus: initial.product_focus,
    primaryKw: initial.primary_keyword ?? "",
    secondaryKw: initial.secondary_keywords.join(", "),
    seoTitle: initial.seo_title ?? "",
    seoDescription: initial.seo_description ?? "",
    heroPrompt: initial.hero_prompt ?? "",
    tags: (initial.tags ?? []).join(", "),
    author: initial.author ?? "",
    authorId: initial.author_id ?? "",
    keyTakeaways: (initial.key_takeaways ?? []).join("\n"),
    faqsText: (initial.faqs ?? [])
      .map((f) => `${f.q} | ${f.a}`)
      .join("\n"),
  });

  const currentMeta: Record<string, string> = {
    title,
    slug,
    excerpt,
    productFocus,
    primaryKw,
    secondaryKw,
    seoTitle,
    seoDescription,
    heroPrompt,
    tags,
    author,
    authorId,
    keyTakeaways,
    faqsText,
  };
  const dirtyLabels = dirtyFieldLabels(currentMeta, savedMeta, {
    title: "Title",
    slug: "Slug",
    excerpt: "Excerpt",
    productFocus: "Product focus",
    primaryKw: "Primary keyword",
    secondaryKw: "Secondary keywords",
    seoTitle: "SEO title",
    seoDescription: "SEO description",
    heroPrompt: "Hero prompt",
    tags: "Tags",
    author: "Author",
    authorId: "Linked author",
    keyTakeaways: "Key takeaways",
    faqsText: "FAQs",
  });
  // US-254: A/B title candidates returned by the last generation. Shown as
  // selectable options until the user picks one (which becomes post.title).
  const [titleSuggestions, setTitleSuggestions] = useState<TitleSuggestion[]>([]);

  const { data: authors } = useBlogAuthors();
  const update = useUpdateBlogPost(postId);
  const publish = usePublishBlogPost(postId);
  const generate = useGenerateBlogPost(postId);
  const heroGen = useGenerateHero(postId, "blog");
  // Not while a save is in flight: the fields are on their way to the server,
  // and a dialog about work that is being saved is how a guard stops working.
  const guard = useNavigationGuard(
    dirtyLabels.length > 0 && !saving && !update.isPending,
  );
  const preview = useCreatePreviewLink(postId);
  // US-251 / US-252: live-streaming compose + section-regen actions.
  const aiStream = useContentAiStream(editor, postId);

  // Debounced autosave of body HTML. Other fields save on Save click.
  useEffect(() => {
    if (body === lastSavedRef.current) return;
    const t = window.setTimeout(async () => {
      setSaving(true);
      try {
        await update.mutateAsync({ body_html: body });
        lastSavedRef.current = body;
      } finally {
        setSaving(false);
      }
    }, 1500);
    bodyTimerRef.current = t;
    return () => window.clearTimeout(t);
  }, [body, update]);

  // Parse the "Question | Answer" textarea into structured FAQ pairs.
  const parseFaqs = (raw: string): { q: string; a: string }[] =>
    raw
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("|");
        if (idx === -1) return null;
        const q = line.slice(0, idx).trim();
        const a = line.slice(idx + 1).trim();
        return q && a ? { q, a } : null;
      })
      .filter((f): f is { q: string; a: string } => f !== null);

  const saveMeta = async () => {
    // Cancel any pending body autosave so this explicit Save is the single
    // in-flight write, and fold the latest body into it so nothing is lost
    // (US-798).
    if (bodyTimerRef.current !== undefined) {
      window.clearTimeout(bodyTimerRef.current);
      bodyTimerRef.current = undefined;
    }
    await update.mutateAsync({
      body_html: body,
      title,
      slug: slug || undefined,
      excerpt: excerpt || null,
      product_focus: productFocus,
      primary_keyword: primaryKw || null,
      secondary_keywords: secondaryKw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      seo_title: seoTitle || null,
      seo_description: seoDescription || null,
      hero_prompt: heroPrompt || null,
      tags: tags
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      // GEO / E-E-A-T fields (US-304); linked author entity (US-874).
      author: author.trim() || null,
      author_id: authorId || null,
      key_takeaways: keyTakeaways
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      faqs: parseFaqs(faqsText),
    });
    lastSavedRef.current = body;
    setSavedMeta(currentMeta);
    toast.success("Saved.");
  };

  const runGenerate = async () => {
    if (!title.trim() || !primaryKw.trim()) {
      toast.error("Title and primary keyword are required to generate.");
      return;
    }
    // Save meta first so the generator sees current values.
    await saveMeta();
    const result = await generate.mutateAsync({});
    // Sync local state from the generated post.
    if (result?.post) {
      const p = result.post as unknown as BlogPostShape;
      setTitle(p.title);
      setSlug(p.slug);
      setExcerpt(p.excerpt ?? "");
      setBody(p.body_html);
      setSeoTitle(p.seo_title ?? "");
      setSeoDescription(p.seo_description ?? "");
      setSecondaryKw((p.secondary_keywords ?? []).join(", "));
      setHeroPrompt(p.hero_prompt ?? "");
      editor?.commands.setContent(p.body_html);
      lastSavedRef.current = p.body_html;
      setStatus(p.status);
    }
    // US-254: offer the A/B title candidates (only worth showing >1).
    const suggestions = result?.title_suggestions ?? [];
    setTitleSuggestions(suggestions.length > 1 ? suggestions : []);
  };

  // US-254: commit a chosen title variant — updates the field and persists it
  // so content_history_index.title (stamped at publish) reflects the choice.
  const pickTitle = async (chosen: string) => {
    setTitle(chosen);
    setTitleSuggestions([]);
    await update.mutateAsync({ title: chosen });
  };

  const runPublish = async () => {
    if (
      !(await confirm({
        title: "Publish this post now?",
        description: "It will become publicly visible on the blog immediately.",
        confirmLabel: "Publish post",
      }))
    )
      return;
    await saveMeta(); // Make sure any unsaved meta edits are persisted first.
    await publish.mutateAsync();
    setStatus("published");
  };

  const runPreview = async () => {
    // Save meta first so the preview reflects the latest title/slug.
    await saveMeta();
    const link = await preview.mutateAsync({});
    if (link?.url) {
      try {
        await navigator.clipboard.writeText(link.url);
        toast.success(
          `Preview link copied — valid until ${new Date(link.expires_at).toLocaleTimeString()}`,
        );
      } catch {
        window.prompt("Copy this preview link:", link.url);
      }
      window.open(link.url, "_blank", "noopener");
    }
  };

  return (
    <div className="space-y-4">
      <SEO title={`Editing — ${title || "untitled"}`} noindex />
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <div className="flex items-center gap-2">
          <Badge
            variant={status === "published" ? "default" : "secondary"}
          >
            {CONTENT_STATUS_LABELS[
              status as keyof typeof CONTENT_STATUS_LABELS
            ] ?? status}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {saving ? "Saving…" : "Saved"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={runGenerate}
            disabled={generate.isPending || aiStream.isStreaming}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {generate.isPending ? "Generating…" : "Generate"}
          </Button>
          <AiStreamButton
            isStreaming={aiStream.isStreaming}
            onCompose={() => aiStream.compose()}
            onStop={aiStream.stop}
            disabled={generate.isPending}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={runPreview}
            disabled={preview.isPending || !body.trim()}
            title="Mints a 30-minute signed preview link"
          >
            <Eye className="mr-2 h-4 w-4" />
            {preview.isPending ? "…" : "Preview"}
          </Button>
          <Button
            size="sm"
            onClick={runPublish}
            disabled={publish.isPending || !body.trim()}
          >
            <Send className="mr-2 h-4 w-4" />
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* Editor column */}
        <div className="space-y-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Post title"
            placeholder="Title…"
            className="h-12 text-xl font-semibold"
          />
          {titleSuggestions.length > 1 && (
            <div className="rounded-md border border-dashed border-input bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Pick a headline (A/B title test) — choose one before publishing:
              </p>
              <div className="space-y-1.5">
                {titleSuggestions.map((s) => {
                  const active = s.title === title;
                  return (
                    <button
                      key={`${s.style}-${s.title}`}
                      type="button"
                      onClick={() => pickTitle(s.title)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors",
                        active
                          ? "border-brand-navy bg-brand-navy/5 ring-2 ring-brand-navy/20"
                          : "border-border hover:border-brand-navy/40 hover:bg-muted/40",
                      )}
                    >
                      <Badge variant="secondary" className="shrink-0">
                        {TITLE_STYLE_LABELS[s.style]}
                      </Badge>
                      <span className="flex-1">{s.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <TiptapToolbar
            editor={editor}
            ai={{
              regenerate: aiStream.regenerate,
              isStreaming: aiStream.isStreaming,
            }}
          />
          <TiptapEditor
            initialHtml={initial.body_html}
            onChange={setBody}
            onReady={setEditor}
          />
        </div>

        {/* SEO + meta sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Meta</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="bp-slug">Slug</Label>
                <Input
                  id="bp-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="bp-product">Product focus</Label>
                <Select
                  value={productFocus}
                  onValueChange={(v) => setProductFocus(v as ContentProduct)}
                >
                  <SelectTrigger id="bp-product">
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
              <div>
                <Label htmlFor="bp-excerpt">Excerpt</Label>
                <Textarea
                  id="bp-excerpt"
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">SEO</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="bp-pk">Primary keyword</Label>
                <Input
                  id="bp-pk"
                  value={primaryKw}
                  onChange={(e) => setPrimaryKw(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="bp-sk">Secondary keywords (comma)</Label>
                <Input
                  id="bp-sk"
                  value={secondaryKw}
                  onChange={(e) => setSecondaryKw(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="bp-st">SEO title</Label>
                <Input
                  id="bp-st"
                  value={seoTitle}
                  onChange={(e) => setSeoTitle(e.target.value)}
                  maxLength={70}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {seoTitle.length}/70
                </p>
              </div>
              <div>
                <Label htmlFor="bp-sd">SEO description</Label>
                <Textarea
                  id="bp-sd"
                  value={seoDescription}
                  onChange={(e) => setSeoDescription(e.target.value)}
                  rows={3}
                  maxLength={170}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {seoDescription.length}/170
                </p>
              </div>
              <div>
                <Label htmlFor="bp-tags">Tags (comma)</Label>
                <Input
                  id="bp-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="grading, denim, vintage"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Answer engine (GEO)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="bp-author-entity">Author</Label>
                <Select
                  value={authorId || "none"}
                  onValueChange={(v) => setAuthorId(v === "none" ? "" : v)}
                >
                  <SelectTrigger id="bp-author-entity">
                    <SelectValue placeholder="Select an author" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No linked author</SelectItem>
                    {(authors ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.title ? ` — ${a.title}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Links to an E-E-A-T author page + Person structured data. Manage
                  authors in Content → Authors.
                </p>
              </div>
              <div>
                <Label htmlFor="bp-author">Byline fallback</Label>
                <Input
                  id="bp-author"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="e.g. Jane Doe (used only when no author is linked)"
                />
              </div>
              <div>
                <Label htmlFor="bp-takeaways">Key takeaways (one per line)</Label>
                <Textarea
                  id="bp-takeaways"
                  value={keyTakeaways}
                  onChange={(e) => setKeyTakeaways(e.target.value)}
                  rows={4}
                  placeholder={"Answer-first summary bullet\nAnother key point"}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Shown as an answer-first summary near the top.
                </p>
              </div>
              <div>
                <Label htmlFor="bp-faqs">FAQs (Question | Answer per line)</Label>
                <Textarea
                  id="bp-faqs"
                  value={faqsText}
                  onChange={(e) => setFaqsText(e.target.value)}
                  rows={5}
                  placeholder={"What is X? | X is …\nHow do I Y? | You can …"}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Rendered on-page and as FAQPage structured data.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Hero image</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {initial.hero_image_url ? (
                <img
                  src={initial.hero_image_url}
                  alt="Hero"
                  className="w-full rounded-md border"
                />
              ) : (
                <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                  No hero yet
                </div>
              )}
              <div>
                <Label htmlFor="bp-hp">Image prompt</Label>
                <Textarea
                  id="bp-hp"
                  value={heroPrompt}
                  onChange={(e) => setHeroPrompt(e.target.value)}
                  rows={3}
                  placeholder="Editorial photo of …"
                />
              </div>
              <Button
                variant="outline"
                className="w-full"
                disabled={heroGen.isPending || !heroPrompt.trim()}
                onClick={() => heroGen.mutate({ prompt: heroPrompt })}
              >
                <ImageIcon className="mr-2 h-4 w-4" />
                {heroGen.isPending ? "Generating…" : "Generate hero"}
              </Button>
            </CardContent>
          </Card>

          <Button
            variant="outline"
            className="w-full"
            onClick={saveMeta}
            disabled={update.isPending}
          >
            <Save className="mr-2 h-4 w-4" /> Save meta
          </Button>
        </div>
      </div>
      {/* US-2536: the body autosaves; the title, slug and SEO fields do not. Leaving used to
          take them with no warning at all. The dialog NAMES them, because
          "unsaved changes" is easy to click through and "Title, SEO
          description" is not. */}
      <AlertDialog
        open={guard.blocked}
        onOpenChange={(open) => {
          if (!open) guard.cancelLeave();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {unsavedSummary(dirtyLabels)} {dirtyLabels.length === 1 ? "has" : "have"}
              {" "}unsaved changes. The body text is saved automatically; these
              fields are not.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={guard.cancelLeave}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction onClick={guard.confirmLeave}>
              Leave and discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
