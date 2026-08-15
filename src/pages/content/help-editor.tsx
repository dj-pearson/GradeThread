import { useEffect, useMemo, useState } from "react";
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
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  useHelpArticle,
  useHelpCategories,
  useUpdateHelpArticle,
} from "@/hooks/use-help-center";
import {
  HELP_AUDIENCE_LABELS,
  HELP_AUDIENCES,
  HELP_STATUS_LABELS,
  HELP_STATUSES,
  HELP_VISIBILITIES,
  HELP_VISIBILITY_HINTS,
  HELP_VISIBILITY_LABELS,
  helpArticlePath,
  isReservedHelpSlug,
  slugifyHelp,
  type HelpAudience,
  type HelpArticleStatus,
  type HelpFaqPair,
  type HelpVisibility,
} from "@/types/help-center";

// Help Center article editor (US-2574).
//
// The one field here with a consequence a mistake cannot be walked back from is
// visibility. Taking a live public article to members or internal silently kills
// a URL that is already indexed and already linked from elsewhere, so that
// direction asks for confirmation and says the words "starts returning 404".
// Everything else saves without ceremony.

export function HelpEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data: article, isLoading } = useHelpArticle(id);
  const { data: categories = [] } = useHelpCategories();
  const update = useUpdateHelpArticle();

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [summary, setSummary] = useState("");
  const [categoryKey, setCategoryKey] = useState("");
  const [audience, setAudience] = useState<HelpAudience>("all");
  const [visibility, setVisibility] = useState<HelpVisibility>("public");
  const [status, setStatus] = useState<HelpArticleStatus>("draft");
  const [pillarPath, setPillarPath] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [heroImageUrl, setHeroImageUrl] = useState("");
  const [relatedInput, setRelatedInput] = useState("");
  const [faq, setFaq] = useState<HelpFaqPair[]>([]);
  const [bodyHtml, setBodyHtml] = useState("");
  const [editor, setEditor] = useState<TiptapEditorInstance | null>(null);

  // Hydrate once the row arrives. Keyed on id so switching articles reloads.
  useEffect(() => {
    if (!article) return;
    setTitle(article.title);
    setSlug(article.slug);
    setSlugTouched(true);
    setSummary(article.summary);
    setCategoryKey(article.category_key);
    setAudience(article.audience);
    setVisibility(article.visibility);
    setStatus(article.status);
    setPillarPath(article.pillar_path ?? "");
    setVideoUrl(article.video_url ?? "");
    setHeroImageUrl(article.hero_image_url ?? "");
    setRelatedInput((article.related_slugs ?? []).join(", "));
    setFaq(article.faq ?? []);
    setBodyHtml(article.body_html);
  }, [article]);

  // An untouched slug tracks the title, the way the blog editor does. Once the
  // author edits it by hand it stops moving, because a slug is a URL and a URL
  // that changes under you is a broken link somebody else already shared.
  useEffect(() => {
    if (!slugTouched) setSlug(slugifyHelp(title));
  }, [title, slugTouched]);

  const categorySlug = useMemo(
    () => categories.find((c) => c.key === categoryKey)?.slug ?? categoryKey,
    [categories, categoryKey],
  );

  const slugError = useMemo(() => {
    if (!slug) return "A slug is required.";
    if (isReservedHelpSlug(slug)) return `"${slug}" is reserved for the help center itself.`;
    if (slug !== slugifyHelp(slug)) return "Lowercase letters, numbers and dashes only.";
    return null;
  }, [slug]);

  const wasLivePublic =
    article?.visibility === "public" && article?.status === "published";
  const willHide = wasLivePublic && (visibility !== "public" || status !== "published");

  const save = async () => {
    if (slugError) {
      toast.error(slugError);
      return;
    }
    if (!title.trim()) {
      toast.error("A title is required.");
      return;
    }
    if (!id) return;

    if (willHide) {
      const ok = await confirm({
        title: "This will take the page off the public web",
        description:
          `${helpArticlePath(categorySlug, article?.slug ?? slug)} is live and indexed. ` +
          "Saving this makes it return 404 for anyone who is not signed in, including " +
          "Google and anyone who already shared the link.",
        confirmLabel: "Hide it anyway",
        destructive: true,
      });
      if (!ok) return;
    }

    const related = relatedInput
      .split(",")
      .map((s) => slugifyHelp(s))
      .filter(Boolean);

    await update.mutateAsync({
      id,
      title: title.trim(),
      slug,
      summary: summary.trim(),
      body_html: bodyHtml,
      category_key: categoryKey,
      audience,
      visibility,
      status,
      pillar_path: pillarPath.trim() || null,
      video_url: videoUrl.trim() || null,
      hero_image_url: heroImageUrl.trim() || null,
      related_slugs: related,
      faq: faq.filter((f) => f.question.trim() && f.answer.trim()),
    });
    toast.success("Saved.");
  };

  if (isLoading || !article) {
    return (
      <LoadingRegion label="Loading article" className="p-4">
        <SkeletonRows rows={8} />
      </LoadingRegion>
    );
  }

  return (
    <div className="space-y-4">
      <SEO title={`Help: ${article.title}`} noindex />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => navigate("/admin/content/help")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> All articles
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant={visibility === "public" ? "secondary" : "outline"}>
            {HELP_VISIBILITY_LABELS[visibility]}
          </Badge>
          <Button onClick={() => void save()} disabled={update.isPending || Boolean(slugError)}>
            <Save className="mr-2 h-4 w-4" />
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ── the article itself ── */}
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="space-y-3 pt-6">
              <div className="space-y-1">
                <Label htmlFor="help-title">Title</Label>
                <Input
                  id="help-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What the photo requirements are"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="help-slug">Slug</Label>
                <Input
                  id="help-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value);
                  }}
                  aria-invalid={Boolean(slugError)}
                  aria-describedby="help-slug-hint"
                />
                <p id="help-slug-hint" className="text-sm text-muted-foreground">
                  {slugError ?? (
                    visibility === "public"
                      ? `Public URL: ${helpArticlePath(categorySlug, slug)}`
                      : "Not public, so this slug is only used inside the app."
                  )}
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="help-summary">Summary</Label>
                <Textarea
                  id="help-summary"
                  rows={2}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="One sentence. This is the meta description and the card blurb."
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Body</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {editor && <TiptapToolbar editor={editor} />}
              <TiptapEditor
                key={article.id}
                initialHtml={article.body_html}
                placeholder="Write the answer. Short sentences, real screenshots."
                onChange={setBodyHtml}
                onReady={setEditor}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">FAQ</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFaq([...faq, { question: "", answer: "" }])}
              >
                <Plus className="mr-1 h-4 w-4" /> Add pair
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Each pair becomes FAQ markup on the public page, which is what Google renders
                as a drop-down under the search result.
              </p>
              {faq.length === 0 && (
                <p className="text-sm text-muted-foreground">No pairs yet.</p>
              )}
              {faq.map((pair, i) => (
                <div key={i} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={pair.question}
                      placeholder="Question"
                      aria-label={`FAQ question ${i + 1}`}
                      onChange={(e) => {
                        const next = [...faq];
                        next[i] = { ...pair, question: e.target.value };
                        setFaq(next);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove FAQ pair ${i + 1}`}
                      onClick={() => setFaq(faq.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <Textarea
                    rows={2}
                    value={pair.answer}
                    placeholder="Answer"
                    aria-label={`FAQ answer ${i + 1}`}
                    onChange={(e) => {
                      const next = [...faq];
                      next[i] = { ...pair, answer: e.target.value };
                      setFaq(next);
                    }}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* ── placement and reach ── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Who can read this</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="help-visibility">Visibility</Label>
                <Select
                  value={visibility}
                  onValueChange={(v) => setVisibility(v as HelpVisibility)}
                >
                  <SelectTrigger id="help-visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HELP_VISIBILITIES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {HELP_VISIBILITY_LABELS[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {HELP_VISIBILITY_HINTS[visibility]}
                </p>
              </div>

              {willHide && (
                <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive-foreground">
                  This article is live and public right now. Saving takes
                  {" "}
                  {helpArticlePath(categorySlug, article.slug)} off the web: it will return 404
                  for anyone not signed in, including search engines and anyone who already
                  shared the link.
                </p>
              )}

              <div className="space-y-1">
                <Label htmlFor="help-status">Status</Label>
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as HelpArticleStatus)}
                >
                  <SelectTrigger id="help-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HELP_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {HELP_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="help-audience">Written for</Label>
                <Select value={audience} onValueChange={(v) => setAudience(v as HelpAudience)}>
                  <SelectTrigger id="help-audience">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HELP_AUDIENCES.map((a) => (
                      <SelectItem key={a} value={a}>
                        {HELP_AUDIENCE_LABELS[a]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Placement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="help-category">Category</Label>
                <Select value={categoryKey} onValueChange={setCategoryKey}>
                  <SelectTrigger id="help-category">
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

              <div className="space-y-1">
                <Label htmlFor="help-pillar">Pillar page</Label>
                <Input
                  id="help-pillar"
                  value={pillarPath}
                  onChange={(e) => setPillarPath(e.target.value)}
                  placeholder="/condition-grading"
                />
                <p className="text-sm text-muted-foreground">
                  The marketing page this links up to, so the article is not an orphan.
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="help-related">Related articles</Label>
                <Input
                  id="help-related"
                  value={relatedInput}
                  onChange={(e) => setRelatedInput(e.target.value)}
                  placeholder="photo-tips, your-first-grade"
                />
                <p className="text-sm text-muted-foreground">Slugs, comma separated.</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Media</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="help-hero">Hero image URL</Label>
                <Input
                  id="help-hero"
                  value={heroImageUrl}
                  onChange={(e) => setHeroImageUrl(e.target.value)}
                  placeholder="https://…"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="help-video">Video URL</Label>
                <Input
                  id="help-video"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  placeholder="https://…"
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
