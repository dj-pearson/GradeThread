import { useMemo, useState } from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { SEO } from "@/components/seo";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import {
  type ChangelogAudience,
  type ChangelogCategory,
  type ChangelogEntryRow,
  type ChangelogInput,
  type ChangelogStatus,
  useAutoCaptureChangelog,
  useChangelogEntries,
  useCreateChangelogEntry,
  useDeleteChangelogEntry,
  useUpdateChangelogEntry,
} from "@/hooks/use-changelog";

const CATEGORIES: ChangelogCategory[] = ["feature", "improvement", "fix", "announcement"];
const AUDIENCES: ChangelogAudience[] = ["all", "grading", "flipdesk", "verified"];

const AUDIENCE_LABEL: Record<ChangelogAudience, string> = {
  all: "Everyone",
  grading: "Grading",
  flipdesk: "FlipDesk",
  verified: "Verified",
};

interface Draft {
  title: string;
  summary: string;
  body: string;
  category: ChangelogCategory;
  audience: ChangelogAudience;
  image_url: string;
  status: ChangelogStatus;
}

function emptyDraft(): Draft {
  return {
    title: "",
    summary: "",
    body: "",
    category: "feature",
    audience: "all",
    image_url: "",
    status: "draft",
  };
}

function rowToDraft(r: ChangelogEntryRow): Draft {
  return {
    title: r.title,
    summary: r.summary ?? "",
    body: r.body ?? "",
    category: r.category,
    audience: r.audience,
    image_url: r.image_url ?? "",
    status: r.status,
  };
}

function draftToInput(d: Draft): ChangelogInput {
  return {
    title: d.title.trim(),
    summary: d.summary.trim() || null,
    body: d.body.trim() || null,
    category: d.category,
    audience: d.audience,
    image_url: d.image_url.trim() || null,
    status: d.status,
  };
}

// US-916: Admin "What's New" changelog. Author / curate structured release notes
// that power the autonomous newsletter's "what's new" section (published
// entries, audience-gated). Auto-capture drafts entries from recently published
// blog posts for human-light curation.
//
// US-2809, in two passes. This claimed the entries also power "the public
// /changelog feed", which was false: the API was built and no reader ever was.
// An earlier pass took the honest short road and DELETED the claim, on the
// grounds that telling an admin their post goes somewhere public when it does
// not is worse than telling them nothing — and it left a note saying the line
// comes back if the feed is built.
//
// It is built. src/pages/marketing/changelog.tsx reads /api/changelog and is
// registered in public-routes.ts and entry-server.tsx, so /changelog prerenders
// like any other public page. The claim is restored because it is now true, and
// this history stays because the sequence is the point: the copy was corrected
// DOWN to the truth and then back UP as the truth changed, rather than being
// left aspirational in between.
//
// The in-app "What's New" panel is still unbuilt, and no copy here claims it.
// That is the surface the ?audience= filter was designed for.
export function ChangelogPage() {
  const confirm = useConfirm();
  const { data: entries, isLoading } = useChangelogEntries();
  const create = useCreateChangelogEntry();
  const update = useUpdateChangelogEntry();
  const remove = useDeleteChangelogEntry();
  const autoCapture = useAutoCaptureChangelog();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const active = useMemo(
    () => (entries ?? []).find((e) => e.id === activeId) ?? null,
    [entries, activeId],
  );

  function startNew() {
    setActiveId(null);
    setDraft(emptyDraft());
  }

  function selectEntry(r: ChangelogEntryRow) {
    setActiveId(r.id);
    setDraft(rowToDraft(r));
  }

  function save() {
    if (!draft.title.trim()) return;
    const input = draftToInput(draft);
    if (activeId) {
      update.mutate({ id: activeId, input });
    } else {
      create.mutate(input, {
        onSuccess: (res) => setActiveId(res.entry.id),
      });
    }
  }

  const saving = create.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <SEO title="Changelog" noindex />
      <PageHeader
        title="What's New"
        subtitle={
          <>
            Product changelog powering the public{" "}
            <a href="/changelog" className="underline" target="_blank" rel="noreferrer">
              /changelog
            </a>{" "}
            page and the autonomous newsletter. Only <strong>published</strong>{" "}
            entries appear in either. The public page shows every audience;
            the newsletter is audience-gated, so grading-only subscribers never
            get FlipDesk-only news.
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => autoCapture.mutate()}
              disabled={autoCapture.isPending}
            >
              <Sparkles className="mr-2 h-4 w-4" />
              {autoCapture.isPending ? "Scanning…" : "Auto-capture"}
            </Button>
            <Button onClick={startNew}>
              <Plus className="mr-2 h-4 w-4" />
              New entry
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* List */}
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Entries</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-2">
            {isLoading && (
              <LoadingRegion label="Loading changelog" className="p-2">
                <SkeletonRows rows={6} />
              </LoadingRegion>
            )}
            {!isLoading && (entries ?? []).length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                No entries yet. Create one or auto-capture from recent blog posts.
              </p>
            )}
            {(entries ?? []).map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => selectEntry(e)}
                className={`flex w-full flex-col gap-1 rounded-md p-2 text-left text-sm hover:bg-accent ${
                  activeId === e.id ? "bg-accent" : ""
                }`}
              >
                <span className="font-medium">{e.title}</span>
                <span className="flex flex-wrap items-center gap-1">
                  <Badge
                    variant={e.status === "published" ? "default" : "secondary"}
                  >
                    {e.status}
                  </Badge>
                  <Badge variant="outline">{e.category}</Badge>
                  <Badge variant="outline">{AUDIENCE_LABEL[e.audience]}</Badge>
                  {e.source === "auto" && <Badge variant="outline">auto</Badge>}
                  {e.featured_at && <Badge variant="outline">featured</Badge>}
                </span>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Editor */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {activeId ? "Edit entry" : "New entry"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cl-title">Title</Label>
              <Input
                id="cl-title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="What shipped?"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cl-summary">Summary</Label>
              <Input
                id="cl-summary"
                value={draft.summary}
                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                placeholder="One-line summary shown in the feed and newsletter"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cl-body">Body (optional)</Label>
              <Textarea
                id="cl-body"
                value={draft.body}
                rows={5}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder="Longer detail for the public changelog page"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="cl-category">Category</Label>
                <Select
                  value={draft.category}
                  onValueChange={(v) =>
                    setDraft({ ...draft, category: v as ChangelogCategory })
                  }
                >
                  <SelectTrigger id="cl-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cl-audience">Audience</Label>
                <Select
                  value={draft.audience}
                  onValueChange={(v) =>
                    setDraft({ ...draft, audience: v as ChangelogAudience })
                  }
                >
                  <SelectTrigger id="cl-audience">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIENCES.map((aud) => (
                      <SelectItem key={aud} value={aud}>
                        {AUDIENCE_LABEL[aud]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cl-status">Status</Label>
                <Select
                  value={draft.status}
                  onValueChange={(v) =>
                    setDraft({ ...draft, status: v as ChangelogStatus })
                  }
                >
                  <SelectTrigger id="cl-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">draft</SelectItem>
                    <SelectItem value="published">published</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cl-image">Image URL (optional)</Label>
              <Input
                id="cl-image"
                value={draft.image_url}
                onChange={(e) =>
                  setDraft({ ...draft, image_url: e.target.value })
                }
                placeholder="https://…"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button onClick={save} disabled={saving || !draft.title.trim()}>
                {saving ? "Saving…" : activeId ? "Save" : "Create"}
              </Button>
              {active && (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Delete "${active.title}"?`,
                      description: "This cannot be undone.",
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) {
                      remove.mutate(active.id, { onSuccess: startNew });
                    }
                  }}
                  disabled={remove.isPending}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
