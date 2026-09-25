import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, FileText, Plus, Sparkles, Star, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SamplePicker } from "@/components/flipdesk/sample-picker";
import { TemplateEditorDialog } from "@/components/flipdesk/template-editor-dialog";
import { toastError } from "@/lib/toast-error";
import { useWorkspace } from "@/hooks/use-workspace";
import { uniqueName } from "@/lib/starter-presets";
import { cn } from "@/lib/utils";
import {
  TEMPLATES_QUERY_KEY,
  TEMPLATE_NAME_MAX,
  type ListingTemplate,
  addStarterTemplates,
  deleteConfirmText,
  deleteTemplate,
  listTemplates,
  nextSortOrder,
  type SampleAddResult,
  templateSummary,
  templateToInput,
  updateTemplate,
} from "@/lib/flipdesk-templates";
import { STARTER_TEMPLATES } from "@/lib/starter-templates";

// US-2877. The web half of listing templates.
//
// The table, the CRUD API and the iOS editor have all existed since US-674.
// The web could apply a template from the AutoLister bulk grid and could not
// make, change or delete one. So the presets -- which are mostly paragraphs of
// boilerplate -- could only be WRITTEN on a phone.

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  // The editor is mounted per open, keyed, so each open starts from the row.
  const [editor, setEditor] = useState<{
    key: number;
    template: ListingTemplate | null;
    copyOf?: ListingTemplate;
    copyName?: string;
  } | null>(null);
  const openEditor = (template: ListingTemplate | null) =>
    setEditor({ key: Date.now(), template });
  // Viewers see the list and can open a template read-only; every write
  // control is hidden rather than left to fail with a 403 after typing.
  const { can } = useWorkspace();
  const canEdit = can("manage_inventory");
  const [samplesOpen, setSamplesOpen] = useState(false);

  const templatesQuery = useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: listTemplates,
    staleTime: 5 * 60_000,
  });

  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);

  // US-2968: add the ticked starter templates as the seller's own rows.
  //
  // Sequential, and for the same reason as the snippets picker: `createTemplate`
  // needs a distinct `sort_order` per row, and a Promise.all would hand all four
  // the same one. A partial batch is a real outcome: every pick is tried, the
  // dialog stays open with the saved ones unticked, and a line says which did
  // not save and why.
  const [sampleResult, setSampleResult] = useState<SampleAddResult | null>(null);
  const [sampleProgress, setSampleProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const addSamples = useMutation({
    mutationFn: (picks: Array<{ sample: { id: string }; name: string }>) =>
      addStarterTemplates(picks, STARTER_TEMPLATES, nextSortOrder(templates), (done, total) =>
        setSampleProgress({ done, total }),
      ),
    onSettled: () => {
      setSampleProgress(null);
      // Always, not only on success: a partial batch wrote rows, and a stale
      // list would hide them and feed the picker a stale `taken` list.
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    },
    onSuccess: (r) => {
      if (r.failed.length > 0) {
        setSampleResult(r);
        return;
      }
      setSampleResult(null);
      setSamplesOpen(false);
      const added = r.added.length;
      toast.success(
        `Added ${added} template${added === 1 ? "" : "s"}. Edit any of them to make it yours.`,
      );
    },
    onError: (err) =>
      toastError(err, "Those samples were not added.", {
        nextStep: "Check the list. Some of them may have saved before it stopped.",
      }),
  });

  const remove = useMutation({
    mutationFn: (t: ListingTemplate) => deleteTemplate(t.id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    },
    onSuccess: (_v, t) => {
      toast.success(`Deleted "${t.name}".`);
    },
    onError: (err) => toastError(err, "That template was not deleted."),
  });

  // Make default (or stop being the default) in one click: a PUT of the row as
  // stored with only the flag changed, through the edge path that clears the
  // old default only after this row's own write succeeds. Optimistic, rolled
  // back if the server says no.
  const toggleDefault = useMutation({
    mutationFn: (t: ListingTemplate) =>
      updateTemplate(t.id, { ...templateToInput(t), is_default: !t.is_default }),
    onMutate: async (t) => {
      await queryClient.cancelQueries({ queryKey: TEMPLATES_QUERY_KEY });
      const previous = queryClient.getQueryData<ListingTemplate[]>(TEMPLATES_QUERY_KEY);
      queryClient.setQueryData<ListingTemplate[]>(TEMPLATES_QUERY_KEY, (rows) =>
        rows?.map((r) => ({
          ...r,
          is_default: r.id === t.id ? !t.is_default : t.is_default ? r.is_default : false,
        })),
      );
      return { previous };
    },
    onError: (err, _t, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(TEMPLATES_QUERY_KEY, ctx.previous);
      toastError(err, "The default did not change.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    },
  });

  function duplicate(t: ListingTemplate) {
    setEditor({
      key: Date.now(),
      template: null,
      copyOf: t,
      copyName: uniqueName(
        t.name,
        templates.map((x) => x.name),
        TEMPLATE_NAME_MAX,
      ),
    });
  }

  async function confirmDelete(t: ListingTemplate) {
    const ok = await confirm({
      title: `Delete "${t.name}"?`,
      description: deleteConfirmText(t, templates),
      confirmLabel: "Delete template",
      destructive: true,
    });
    if (ok) remove.mutate(t);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Listing templates"
        subtitle="The parts you type on every listing, saved once. Your usual wording, a default condition, your eBay policies."
        icon={FileText}
        actions={
          canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => setSamplesOpen(true)}
                // The picker renames against the loaded list; opened before it
                // loads, it would rename nothing and every clash would 409.
                disabled={!templatesQuery.isSuccess}
              >
                <Sparkles className="mr-1.5 h-4 w-4" />
                Browse samples
              </Button>
              <Button onClick={() => openEditor(null)}>
                <Plus className="mr-1.5 h-4 w-4" />
                New template
              </Button>
            </div>
          )
        }
      />

      {/* A failed background refetch keeps its data in TanStack v5 but still
          reports isError, so ErrorState is only for a list that never loaded. */}
      {templatesQuery.isError && templatesQuery.data === undefined ? (
        <ErrorState
          title="Couldn't load your templates"
          onRetry={() => void templatesQuery.refetch()}
          retrying={templatesQuery.isFetching}
        />
      ) : templatesQuery.isLoading ? (
        <div
          className="flex justify-center py-12"
          role="status"
          aria-label="Loading templates"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : templates.length === 0 ? (
        canEdit ? (
          <EmptyState
            icon={FileText}
            title="No templates yet"
            description="A template saves the parts of a listing you type every time. Make one, and every new listing can start from it."
            action={{
              label: "Make your first template",
              icon: Plus,
              onClick: () => openEditor(null),
            }}
            secondaryAction={{
              label: "Browse samples",
              icon: Sparkles,
              onClick: () => setSamplesOpen(true),
            }}
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="No templates yet"
            description="This workspace has no listing templates. Someone who manages inventory here can add them."
          />
        )
      ) : (
        <div className="space-y-3">
          {templatesQuery.isError && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              Could not refresh.
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => void templatesQuery.refetch()}
                disabled={templatesQuery.isFetching}
              >
                Retry
              </Button>
            </p>
          )}
          {templates.map((t) => (
            <Card key={t.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    {t.is_default && (
                      <Badge variant="secondary" className="shrink-0">
                        <Star className="mr-1 h-3 w-3" />
                        Default
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {templateSummary(t)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-pressed={t.is_default}
                      aria-label={
                        t.is_default
                          ? `Stop using ${t.name} as the default`
                          : `Make ${t.name} the default`
                      }
                      disabled={toggleDefault.isPending}
                      onClick={() => toggleDefault.mutate(t)}
                    >
                      <Star
                        className={cn("h-4 w-4", t.is_default && "fill-current text-primary")}
                      />
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditor(t)}
                    aria-label={`${canEdit ? "Edit" : "View"} ${t.name}`}
                  >
                    {canEdit ? (
                      <Pencil className="mr-1.5 h-4 w-4" />
                    ) : (
                      <Eye className="mr-1.5 h-4 w-4" />
                    )}
                    {canEdit ? "Edit" : "View"}
                  </Button>
                  {canEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => duplicate(t)}
                      aria-label={`Duplicate ${t.name}`}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void confirmDelete(t)}
                      // Only the row being deleted waits; the others stay usable.
                      disabled={remove.isPending && remove.variables?.id === t.id}
                      aria-label={`Delete ${t.name}`}
                    >
                      {remove.isPending && remove.variables?.id === t.id ? (
                        <>
                          <span className="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          Deleting...
                        </>
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editor && (
        <TemplateEditorDialog
          key={editor.key}
          open
          template={editor.template}
          copyOf={editor.copyOf}
          copyName={editor.copyName}
          readOnly={!canEdit}
          templates={templates}
          nextSortOrder={nextSortOrder(templates)}
          onOpenChange={(o) => {
            if (!o) setEditor(null);
          }}
        />
      )}

      <SamplePicker
        open={samplesOpen}
        onOpenChange={(o) => {
          if (o || addSamples.isPending) return;
          setSamplesOpen(false);
          setSampleResult(null);
        }}
        title="Start from a sample"
        description="Four presets built the way resellers actually sort their inventory. Add the ones that fit, then edit them until the wording is yours."
        samples={STARTER_TEMPLATES}
        taken={templates.map((t) => t.name)}
        nameMax={TEMPLATE_NAME_MAX}
        noun="template"
        adding={addSamples.isPending}
        progress={sampleProgress}
        result={sampleResult}
        onAdd={(picks) => addSamples.mutate(picks)}
      />
    </div>
  );
}
