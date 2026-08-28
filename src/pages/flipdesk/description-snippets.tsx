import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  Plus,
  Sparkles,
  StickyNote,
  Trash2,
} from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SamplePicker } from "@/components/flipdesk/sample-picker";
import { toastError } from "@/lib/toast-error";
import { useListingSnippets } from "@/hooks/use-listing-snippets";
import {
  applySnippetToDrafts,
  applySummary,
  bodyProblem,
  nameProblem,
  nextSortOrder,
  reorderSnippets,
  SNIPPET_BODY_MAX,
  SNIPPET_NAME_MAX,
} from "@/lib/flipdesk-snippets";
import { STARTER_SNIPPETS } from "@/lib/starter-snippets";
import type { StarterPreset } from "@/lib/starter-presets";
import type { ListingSnippetRow } from "@/types/database";

// US-2961: the standing lines a seller writes once.
//
// The problem this closes is small and constant: a shipping promise or a
// bundling offer sits in every listing's description, and changing it used to
// mean opening every listing. A snippet is stored on the ACCOUNT and referenced
// by id from a description block, so the fix happens in one place.
//
// Two things about "apply to open drafts" are worth reading before changing it:
//
//   * It is a separate action from saving, because saving already changes what
//     every referencing listing RENDERS. What it does not change is the
//     `listing_description` column a draft has already stored, which is what
//     publish and search read — so this is a catch-up, not the edit itself.
//   * It touches drafts only. A published listing is live copy on eBay, and the
//     seller has to open it, see the preview and push a revise. That rule is
//     enforced on the server, not here.

interface EditorState {
  existing: ListingSnippetRow | null;
  name: string;
  body: string;
  applyToDrafts: boolean;
}

const blankEditor = (existing: ListingSnippetRow | null): EditorState => ({
  existing,
  name: existing?.name ?? "",
  body: existing?.body ?? "",
  // Off for a NEW snippet, which nothing references yet, and on for an edit,
  // where leaving drafts behind is the failure this page exists to prevent.
  applyToDrafts: existing !== null,
});

export function FlipdeskDescriptionSnippetsPage() {
  const snippets = useListingSnippets();
  const confirm = useConfirm();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [addingSamples, setAddingSamples] = useState(false);

  const rows = snippets.snippets;
  const nameIssue = editor
    ? nameProblem(editor.name, rows, editor.existing?.id)
    : null;
  const bodyIssue = editor ? bodyProblem(editor.body) : null;

  async function save() {
    if (!editor || nameIssue || bodyIssue) return;
    setSaving(true);
    try {
      let id: string;
      if (editor.existing) {
        await snippets.update(editor.existing.id, {
          name: editor.name,
          body: editor.body,
        });
        id = editor.existing.id;
      } else {
        const created = await snippets.create({
          name: editor.name,
          body: editor.body,
          sort_order: nextSortOrder(rows),
        });
        id = created.id;
      }
      setEditor(null);
      toast.success(editor.existing ? "Saved." : `Added "${editor.name.trim()}".`);

      if (editor.applyToDrafts) {
        // Deliberately AFTER the snippet write and reported separately: the
        // save succeeded even when the catch-up pass does not, and rolling the
        // two into one message would make a failed re-render look like a lost
        // edit.
        try {
          toast.info(applySummary(await applySnippetToDrafts(id)));
        } catch (err) {
          toastError(err, "Saved, but your open drafts were not updated.");
        }
      }
    } catch (err) {
      toastError(err, "That snippet was not saved.");
    } finally {
      setSaving(false);
    }
  }

  // US-2966: turn the ticked samples into the seller's own rows.
  //
  // Sequential on purpose. `Promise.all` would be one round trip instead of
  // several and would also hand every insert the same `nextSortOrder(rows)`,
  // landing the whole batch on one position and leaving the list to break the
  // tie by name.
  async function addSamples(picks: Array<{ sample: StarterPreset; name: string }>) {
    setAddingSamples(true);
    let added = 0;
    let order = nextSortOrder(rows);
    try {
      for (const { sample, name } of picks) {
        await snippets.create({ name, body: sample.body, sort_order: order });
        order += 1;
        added += 1;
      }
      setSamplesOpen(false);
      toast.success(
        `Added ${added} snippet${added === 1 ? "" : "s"}. Edit any of them to make it yours.`,
      );
    } catch (err) {
      // A half-finished batch is a real outcome, so say how far it got rather
      // than reporting a failure that also wrote four rows.
      toastError(
        err,
        added > 0
          ? `Added ${added}, then stopped. The rest were not saved.`
          : "Those samples were not added.",
      );
    } finally {
      setAddingSamples(false);
    }
  }

  async function move(from: number, to: number) {
    if (to < 0 || to >= rows.length) return;
    try {
      await snippets.reorder(reorderSnippets(rows, from, to));
    } catch (err) {
      toastError(err, "The new order was not saved.");
    }
  }

  async function confirmDelete(s: ListingSnippetRow) {
    const ok = await confirm({
      title: `Delete "${s.name}"?`,
      description:
        "Listings that use it stop showing that section the next time they are " +
        "saved. Anything already published keeps what it says until you revise it.",
      confirmLabel: "Delete snippet",
      destructive: true,
    });
    if (!ok) return;
    try {
      await snippets.remove(s.id);
      toast.success(`Deleted "${s.name}".`);
    } catch (err) {
      toastError(err, "That snippet was not deleted.");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Description snippets"
        subtitle="The standing lines you put in every description. Written once here, referenced from any listing, fixed in one place."
        icon={StickyNote}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setSamplesOpen(true)}>
              <Sparkles className="mr-1.5 h-4 w-4" />
              Browse samples
            </Button>
            <Button onClick={() => setEditor(blankEditor(null))}>
              <Plus className="mr-1.5 h-4 w-4" />
              New snippet
            </Button>
          </div>
        }
      />

      <p className="text-sm text-muted-foreground">
        <Link
          to="/dashboard/flipdesk/inventory"
          className="inline-flex items-center underline underline-offset-4"
        >
          <ChevronLeft className="mr-1 h-3 w-3" />
          Back to inventory
        </Link>
      </p>

      {snippets.isError ? (
        <ErrorState
          title="Couldn't load your snippets"
          onRetry={snippets.refetch}
          retrying={snippets.isFetching}
        />
      ) : snippets.isLoading ? (
        <div
          className="flex justify-center py-12"
          role="status"
          aria-label="Loading snippets"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={StickyNote}
          title="No snippets yet"
          description="A snippet is a line you repeat on every listing: how fast you ship, what a bundle costs, how returns work. Write it once and point your listings at it."
          action={{
            label: "Write your first snippet",
            icon: Plus,
            onClick: () => setEditor(blankEditor(null)),
          }}
          secondaryAction={{
            label: "Browse samples",
            icon: Sparkles,
            onClick: () => setSamplesOpen(true),
          }}
        />
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {rows.map((s, i) => (
              <div key={s.id} className="flex items-start gap-3 p-4">
                <div className="flex shrink-0 flex-col">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1"
                    disabled={i === 0 || snippets.isMutating}
                    aria-label={`Move ${s.name} up`}
                    onClick={() => void move(i, i - 1)}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1"
                    disabled={i === rows.length - 1 || snippets.isMutating}
                    aria-label={`Move ${s.name} down`}
                    onClick={() => void move(i, i + 1)}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.name}</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                    {s.body}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => setEditor(blankEditor(s))}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => void confirmDelete(s)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={editor !== null} onOpenChange={(o) => !o && setEditor(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editor?.existing ? "Edit snippet" : "New snippet"}
            </DialogTitle>
            <DialogDescription>
              The name is for you. The body is what buyers read.
            </DialogDescription>
          </DialogHeader>

          {editor && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="snippet-name">Name</Label>
                <Input
                  id="snippet-name"
                  value={editor.name}
                  maxLength={SNIPPET_NAME_MAX}
                  placeholder="Shipping promise"
                  onChange={(e) =>
                    setEditor({ ...editor, name: e.target.value })
                  }
                />
                {nameIssue && (
                  <p className="text-sm text-destructive">{nameIssue}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="snippet-body">What it says</Label>
                <Textarea
                  id="snippet-body"
                  value={editor.body}
                  rows={6}
                  maxLength={SNIPPET_BODY_MAX}
                  placeholder="Ships within one business day, tracked, from a smoke-free home."
                  onChange={(e) =>
                    setEditor({ ...editor, body: e.target.value })
                  }
                />
                {bodyIssue && (
                  <p className="text-sm text-destructive">{bodyIssue}</p>
                )}
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="snippet-apply"
                  className="mt-1"
                  checked={editor.applyToDrafts}
                  onCheckedChange={(v) =>
                    setEditor({ ...editor, applyToDrafts: v === true })
                  }
                />
                <Label htmlFor="snippet-apply" className="text-sm font-normal">
                  Update my open drafts now
                  <span className="block text-muted-foreground">
                    Drafts only. Anything already listed keeps what it says until
                    you revise it yourself.
                  </span>
                </Label>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button
              disabled={saving || !!nameIssue || !!bodyIssue}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save snippet"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SamplePicker
        open={samplesOpen}
        onOpenChange={(o) => !o && !addingSamples && setSamplesOpen(false)}
        title="Start from a sample"
        description="Nine lines resellers actually repeat. Add the ones that fit and edit them until they sound like you."
        samples={STARTER_SNIPPETS}
        taken={rows.map((s) => s.name)}
        nameMax={SNIPPET_NAME_MAX}
        noun="snippet"
        adding={addingSamples}
        onAdd={(picks) => void addSamples(picks)}
      />
    </div>
  );
}
