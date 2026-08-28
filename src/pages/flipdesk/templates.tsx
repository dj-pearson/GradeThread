import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Sparkles, Star, Trash2, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SamplePicker } from "@/components/flipdesk/sample-picker";
import { toastError } from "@/lib/toast-error";
import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";
import {
  TEMPLATES_QUERY_KEY,
  TEMPLATE_NAME_MAX,
  type ListingTemplate,
  type TemplateInput,
  createTemplate,
  deleteTemplate,
  listTemplates,
  nameProblem,
  templateSummary,
  updateTemplate,
} from "@/lib/flipdesk-templates";
import { STARTER_TEMPLATES } from "@/lib/starter-templates";

// US-2877. The web half of listing templates.
//
// The table, the CRUD API and the iOS editor have all existed since US-674.
// The web could apply a template from the AutoLister bulk grid and could not
// make, change or delete one. So the presets -- which are mostly paragraphs of
// boilerplate -- could only be WRITTEN on a phone.

/** "No default condition" — Select cannot carry an empty-string value. */
const NO_CONDITION = "__none__";

interface SpecificPair {
  key: string;
  name: string;
  value: string;
}

interface EditorState {
  /** The row being edited, or null when this is a new template. */
  existing: ListingTemplate | null;
  name: string;
  descriptionTemplate: string;
  ebayCondition: string;
  conditionDescription: string;
  ebayCategoryId: string;
  shippingPolicyId: string;
  returnPolicyId: string;
  paymentPolicyId: string;
  isDefault: boolean;
  specifics: SpecificPair[];
}

let pairSeq = 0;
const newPair = (name = "", value = ""): SpecificPair => ({
  key: `p${pairSeq++}`,
  name,
  value,
});

function blankEditor(existing: ListingTemplate | null): EditorState {
  return {
    existing,
    name: existing?.name ?? "",
    descriptionTemplate: existing?.description_template ?? "",
    ebayCondition: existing?.ebay_condition ?? "",
    conditionDescription: existing?.condition_description ?? "",
    ebayCategoryId: existing?.ebay_category_id ?? "",
    shippingPolicyId: existing?.shipping_policy_id ?? "",
    returnPolicyId: existing?.return_policy_id ?? "",
    paymentPolicyId: existing?.payment_policy_id ?? "",
    isDefault: existing?.is_default ?? false,
    specifics: Object.entries(existing?.item_specifics ?? {})
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([k, v]) => newPair(k, v)),
  };
}

function toInput(s: EditorState): TemplateInput {
  const item_specifics: Record<string, string> = {};
  for (const p of s.specifics) {
    const name = p.name.trim();
    const value = p.value.trim();
    if (name && value) item_specifics[name] = value;
  }
  return {
    name: s.name,
    description_template: s.descriptionTemplate,
    ebay_condition: s.ebayCondition,
    condition_description: s.conditionDescription,
    ebay_category_id: s.ebayCategoryId,
    shipping_policy_id: s.shippingPolicyId,
    return_policy_id: s.returnPolicyId,
    payment_policy_id: s.paymentPolicyId,
    is_default: s.isDefault,
    item_specifics,
    sort_order: s.existing?.sort_order ?? 0,
  };
}

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [samplesOpen, setSamplesOpen] = useState(false);

  const templatesQuery = useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: listTemplates,
    staleTime: 5 * 60_000,
  });

  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);

  const save = useMutation({
    mutationFn: async (state: EditorState) => {
      const input = toInput(state);
      return state.existing
        ? updateTemplate(state.existing.id, input)
        : createTemplate(input);
    },
    onSuccess: (saved, state) => {
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
      setEditor(null);
      toast.success(
        state.existing ? `Saved "${saved.name}".` : `Created "${saved.name}".`,
      );
    },
    onError: (err) =>
      toastError(err, "That did not save.", {
        // The one failure a seller can act on themselves: two templates cannot
        // share a name (a partial unique index, not a validation rule we chose).
        nextStep: "If the name is already taken, pick a different one.",
      }),
  });

  // US-2968: add the ticked starter templates as the seller's own rows.
  //
  // Sequential, and for the same reason as the snippets picker: `createTemplate`
  // needs a distinct `sort_order` per row, and a Promise.all would hand all four
  // the same one. A partial batch is a real outcome -- the count is reported, so
  // "added 2 of 4" does not read as a total failure that nonetheless wrote two
  // rows.
  const addSamples = useMutation({
    mutationFn: async (
      picks: Array<{ sample: { id: string }; name: string }>,
    ) => {
      let order = templates.reduce((max, t) => Math.max(max, t.sort_order), -1) + 1;
      let added = 0;
      for (const { sample, name } of picks) {
        const starter = STARTER_TEMPLATES.find((t) => t.id === sample.id);
        if (!starter) continue;
        await createTemplate({
          name,
          description_template: starter.body,
          ebay_condition: starter.ebayCondition,
          condition_description: starter.conditionDescription,
          // No item specifics and no policy ids: those are the seller's own
          // eBay account values, and no starter can guess them. Nor is_default
          // -- picking a favourite stays their call.
          item_specifics: {},
          is_default: false,
          sort_order: order,
        });
        order += 1;
        added += 1;
      }
      return added;
    },
    onSuccess: (added) => {
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
      setSamplesOpen(false);
      toast.success(
        `Added ${added} template${added === 1 ? "" : "s"}. Edit any of them to make it yours.`,
      );
    },
    onError: (err) =>
      toastError(err, "Those samples were not added.", {
        nextStep: "Check the list — some of them may have saved before it stopped.",
      }),
  });

  const remove = useMutation({
    mutationFn: (t: ListingTemplate) => deleteTemplate(t.id),
    onSuccess: (_v, t) => {
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
      toast.success(`Deleted "${t.name}".`);
    },
    onError: (err) => toastError(err, "That template was not deleted."),
  });

  async function confirmDelete(t: ListingTemplate) {
    const ok = await confirm({
      title: `Delete "${t.name}"?`,
      description:
        "Listings you already made with it keep everything it filled in. " +
        "You just will not be able to apply it again.",
      confirmLabel: "Delete template",
      destructive: true,
    });
    if (ok) remove.mutate(t);
  }

  const problem = editor ? nameProblem(editor.name) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Listing templates"
        subtitle="The parts you type on every listing, saved once. Your usual wording, a default condition, your eBay policies."
        icon={FileText}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setSamplesOpen(true)}>
              <Sparkles className="mr-1.5 h-4 w-4" />
              Browse samples
            </Button>
            <Button onClick={() => setEditor(blankEditor(null))}>
              <Plus className="mr-1.5 h-4 w-4" />
              New template
            </Button>
          </div>
        }
      />

      {templatesQuery.isError ? (
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
        <EmptyState
          icon={FileText}
          title="No templates yet"
          description="A template saves the parts of a listing you type every time. Make one, and every new listing can start from it."
          action={{
            label: "Make your first template",
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
        <div className="space-y-3">
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditor(blankEditor(t))}
                    aria-label={`Edit ${t.name}`}
                  >
                    <Pencil className="mr-1.5 h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void confirmDelete(t)}
                    disabled={remove.isPending}
                    aria-label={`Delete ${t.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.existing ? "Edit template" : "New template"}
            </DialogTitle>
            <DialogDescription>
              Everything here is optional except the name. Leave a field blank
              and the template will not touch it.
            </DialogDescription>
          </DialogHeader>

          {editor && (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={editor.name}
                  maxLength={TEMPLATE_NAME_MAX}
                  placeholder="e.g. Vintage denim"
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                />
                {problem && <p className="text-sm text-destructive">{problem}</p>}
              </div>

              <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="min-w-0">
                  <Label htmlFor="tpl-default">Use this one by default</Label>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    It gets picked for you when you publish or run AutoLister.
                    Only one template can be the default.
                  </p>
                </div>
                <Switch
                  id="tpl-default"
                  checked={editor.isDefault}
                  onCheckedChange={(v) => setEditor({ ...editor, isDefault: v })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="tpl-desc">Description boilerplate</Label>
                <Textarea
                  id="tpl-desc"
                  rows={4}
                  value={editor.descriptionTemplate}
                  placeholder="e.g. Ships next business day. Smoke-free home. Bundle to save."
                  onChange={(e) =>
                    setEditor({ ...editor, descriptionTemplate: e.target.value })
                  }
                />
                <p className="text-sm text-muted-foreground">
                  Added after the listing's own description. It never replaces
                  what is already written.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="tpl-condition">Default condition</Label>
                  <Select
                    value={editor.ebayCondition || NO_CONDITION}
                    onValueChange={(v) =>
                      setEditor({
                        ...editor,
                        ebayCondition: v === NO_CONDITION ? "" : v,
                      })
                    }
                  >
                    <SelectTrigger id="tpl-condition">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CONDITION}>No default</SelectItem>
                      {EBAY_CONDITION_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tpl-cat">eBay category ID</Label>
                  <Input
                    id="tpl-cat"
                    inputMode="numeric"
                    value={editor.ebayCategoryId}
                    placeholder="Optional"
                    onChange={(e) =>
                      setEditor({ ...editor, ebayCategoryId: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="tpl-cond-note">Condition note</Label>
                <Textarea
                  id="tpl-cond-note"
                  rows={2}
                  value={editor.conditionDescription}
                  placeholder="Optional. e.g. Measured flat, see photos for wear."
                  onChange={(e) =>
                    setEditor({ ...editor, conditionDescription: e.target.value })
                  }
                />
              </div>

              <div className="space-y-3">
                <div>
                  <Label>Business policies</Label>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    The shipping, payment and returns policies you set up on
                    eBay. AutoLister puts them on every draft it writes.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Input
                    aria-label="Shipping policy ID"
                    value={editor.shippingPolicyId}
                    placeholder="Shipping policy ID"
                    onChange={(e) =>
                      setEditor({ ...editor, shippingPolicyId: e.target.value })
                    }
                  />
                  <Input
                    aria-label="Return policy ID"
                    value={editor.returnPolicyId}
                    placeholder="Return policy ID"
                    onChange={(e) =>
                      setEditor({ ...editor, returnPolicyId: e.target.value })
                    }
                  />
                  <Input
                    aria-label="Payment policy ID"
                    value={editor.paymentPolicyId}
                    placeholder="Payment policy ID"
                    onChange={(e) =>
                      setEditor({ ...editor, paymentPolicyId: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <Label>Item details</Label>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Details that are the same on every listing this template
                    makes, like Brand or Country of manufacture.
                  </p>
                </div>
                {editor.specifics.map((p, i) => (
                  <div key={p.key} className="flex gap-2">
                    <Input
                      aria-label={`Detail ${i + 1} name`}
                      value={p.name}
                      placeholder="Name"
                      onChange={(e) => {
                        const next = [...editor.specifics];
                        next[i] = { ...p, name: e.target.value };
                        setEditor({ ...editor, specifics: next });
                      }}
                    />
                    <Input
                      aria-label={`Detail ${i + 1} value`}
                      value={p.value}
                      placeholder="Value"
                      onChange={(e) => {
                        const next = [...editor.specifics];
                        next[i] = { ...p, value: e.target.value };
                        setEditor({ ...editor, specifics: next });
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove detail ${i + 1}`}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          specifics: editor.specifics.filter((x) => x.key !== p.key),
                        })
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEditor({ ...editor, specifics: [...editor.specifics, newPair()] })
                  }
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add a detail
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => editor && save.mutate(editor)}
              disabled={save.isPending || problem !== null}
            >
              {save.isPending ? "Saving..." : "Save template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SamplePicker
        open={samplesOpen}
        onOpenChange={(o) => !o && !addSamples.isPending && setSamplesOpen(false)}
        title="Start from a sample"
        description="Four presets built the way resellers actually sort their inventory. Add the ones that fit, then edit them until the wording is yours."
        samples={STARTER_TEMPLATES}
        taken={templates.map((t) => t.name)}
        nameMax={TEMPLATE_NAME_MAX}
        noun="template"
        adding={addSamples.isPending}
        onAdd={(picks) => addSamples.mutate(picks)}
      />
    </div>
  );
}
