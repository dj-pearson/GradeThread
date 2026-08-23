import { useState } from "react";
import { useNavigate } from "react-router";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Plus, X, ArrowRight } from "lucide-react";
import {
  PRODUCT_LABELS,
  SURFACE_LABELS,
  TOPIC_STATUS_LABELS,
} from "@/lib/constants";
import type { ContentProduct, ContentSurface } from "@/types/database";
import {
  useAddTopics,
  useContentTopics,
  usePromoteTopic,
  useRejectTopic,
  useResearchTopics,
  useTopicCounts,
} from "@/hooks/use-content";

// Four tabs: Blog·GT, Blog·FD, Social·GT, Social·FD.
// Each tab shows queued topics + buttons to research more, add manually,
// reject, or promote to a draft.
const TABS: Array<{
  key: string;
  surface: ContentSurface;
  product: ContentProduct;
  label: string;
}> = [
  { key: "blog-gt", surface: "blog", product: "gradethread", label: "Blog · GradeThread" },
  { key: "blog-fd", surface: "blog", product: "flipdesk", label: "Blog · FlipDesk" },
  { key: "soc-gt", surface: "social", product: "gradethread", label: "Social · GradeThread" },
  { key: "soc-fd", surface: "social", product: "flipdesk", label: "Social · FlipDesk" },
];

const DEFAULT_TAB = TABS[0]!.key;

export function TopicBankPage() {
  const [tab, setTab] = useState(DEFAULT_TAB);

  return (
    <div className="space-y-4">
      <SEO title="Topic Bank" noindex />
      <PageHeader
        title="Topic Bank"
        subtitle="Queued titles per (surface × product). Refilled by research or by hand."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="mt-4">
            <BankTab surface={t.surface} product={t.product} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function BankTab({
  surface,
  product,
}: {
  surface: ContentSurface;
  product: ContentProduct;
}) {
  const { data: topics = [], isLoading } = useContentTopics({
    surface,
    product_focus: product,
    status: "queued",
  });
  const { data: counts = {} } = useTopicCounts();
  const research = useResearchTopics();
  const reject = useRejectTopic();
  const promote = usePromoteTopic();
  const navigate = useNavigate();

  const queuedCount = counts[`${surface}:${product}:queued`] ?? 0;
  const usedCount = counts[`${surface}:${product}:used`] ?? 0;

  const handlePromote = async (id: string) => {
    const result = await promote.mutateAsync(id);
    if ("post" in result) {
      const post = result.post as { id: string };
      const path =
        result.surface === "blog"
          ? `/admin/content/blog/editor/${post.id}`
          : `/admin/content/social/editor/${post.id}`;
      navigate(path);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {/* US-2439: through TOPIC_STATUS_LABELS rather than prose, so the
              vocabulary a user reads has ONE home. Lowercased here because it
              is mid-sentence — the map owns the wording, the sentence owns the
              casing, which is the split that lets a status be renamed once. */}
          <span className="font-medium text-foreground">{queuedCount}</span>{" "}
          {TOPIC_STATUS_LABELS.queued.toLowerCase()} · {usedCount}{" "}
          {TOPIC_STATUS_LABELS.used.toLowerCase()}
        </div>
        <div className="flex gap-2">
          <AddTopicDialog surface={surface} product={product} />
          <Button
            disabled={research.isPending}
            onClick={() =>
              research.mutate({
                surface,
                product_focus: product,
                count: 10,
              })
            }
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {research.isPending ? "Researching…" : "Research 10 more"}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="p-4">
            <LoadingRegion label="Loading topics">
              <SkeletonRows rows={6} />
            </LoadingRegion>
          </CardContent>
        </Card>
      ) : topics.length === 0 ? (
        <Card>
          <CardContent className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <span>
              No queued topics for {PRODUCT_LABELS[product]}{" "}
              {SURFACE_LABELS[surface]}.
            </span>
            <span>Click "Research 10 more" to fill the bank.</span>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {topics.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between">
                <div className="flex-1 space-y-1">
                  <p className="font-medium">{t.title}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="secondary" className="font-mono">
                      {t.primary_keyword}
                    </Badge>
                    {t.search_intent && (
                      <Badge variant="outline">{t.search_intent}</Badge>
                    )}
                    {t.secondary_keywords.slice(0, 4).map((kw) => (
                      <span key={kw} className="text-muted-foreground">
                        {kw}
                      </span>
                    ))}
                  </div>
                  {t.angle && (
                    <p className="text-sm text-muted-foreground">{t.angle}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                  aria-label={`Reject ${t.title}`}
                    variant="outline"
                    size="sm"
                    disabled={reject.isPending}
                    onClick={() => reject.mutate(t.id)}
                  >
                    <X className="mr-1 h-3.5 w-3.5" /> Reject
                  </Button>
                  <Button
                  aria-label={`Promote ${t.title}`}
                    size="sm"
                    disabled={promote.isPending}
                    onClick={() => handlePromote(t.id)}
                  >
                    Promote <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AddTopicDialog({
  surface,
  product,
}: {
  surface: ContentSurface;
  product: ContentProduct;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [primaryKw, setPrimaryKw] = useState("");
  const [secondaryKw, setSecondaryKw] = useState("");
  const [angle, setAngle] = useState("");
  const add = useAddTopics();

  const submit = async () => {
    if (!title.trim() || !primaryKw.trim()) return;
    await add.mutateAsync({
      surface,
      product_focus: product,
      candidates: [
        {
          title: title.trim(),
          primary_keyword: primaryKw.trim().toLowerCase(),
          secondary_keywords: secondaryKw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
          angle: angle.trim() || undefined,
        },
      ],
    });
    setTitle("");
    setPrimaryKw("");
    setSecondaryKw("");
    setAngle("");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus className="mr-2 h-4 w-4" /> Add manually
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add topic</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="t-title">Title</Label>
            <Input
              id="t-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="How to grade a vintage band tee"
            />
          </div>
          <div>
            <Label htmlFor="t-pk">Primary keyword</Label>
            <Input
              id="t-pk"
              value={primaryKw}
              onChange={(e) => setPrimaryKw(e.target.value)}
              placeholder="how to grade vintage band tee"
            />
          </div>
          <div>
            <Label htmlFor="t-sk">Secondary keywords (comma-separated)</Label>
            <Input
              id="t-sk"
              value={secondaryKw}
              onChange={(e) => setSecondaryKw(e.target.value)}
              placeholder="vintage tee condition, single stitch, tag dating"
            />
          </div>
          <div>
            <Label htmlFor="t-angle">Angle (optional)</Label>
            <Textarea
              id="t-angle"
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              placeholder="Defects-first walkthrough that distinguishes wear from damage."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={add.isPending || !title || !primaryKw} onClick={submit}>
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
