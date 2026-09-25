import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import { toastError } from "@/lib/toast-error";
import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";
import {
  TEMPLATES_QUERY_KEY,
  TEMPLATE_NAME_MAX,
  TemplateApiError,
  type ListingTemplate,
  type TemplateInput,
  createTemplate,
  nameProblem,
  normalizeInput,
  saveErrorNextStep,
  updateTemplate,
} from "@/lib/flipdesk-templates";

// The listing template editor, split out of the templates page so it can own
// its own state (a keystroke no longer re-renders the whole list) and guard
// unsaved work: Escape, an outside click, the X and Cancel all go through
// requestClose(), which asks before throwing away paragraphs of footer text.

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
  sortOrder: number;
}

let pairSeq = 0;
const newPair = (name = "", value = ""): SpecificPair => ({
  key: `p${pairSeq++}`,
  name,
  value,
});

function blankEditor(
  existing: ListingTemplate | null,
  sortOrder = 0,
): EditorState {
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
    sortOrder: existing?.sort_order ?? sortOrder,
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
    sort_order: s.sortOrder,
  };
}

/** A stable fingerprint of what Save would send, for the dirty check. */
function fingerprint(s: EditorState): string {
  // Half-filled detail rows are not in toInput, but they are typing a seller
  // would lose, so they count toward dirty too.
  return JSON.stringify([
    normalizeInput(toInput(s)),
    s.specifics.map((p) => [p.name, p.value]),
  ]);
}

export interface TemplateEditorDialogProps {
  open: boolean;
  /** The row being edited, or null for a new template. */
  template: ListingTemplate | null;
  /** Every template on the account, for duplicate-name checks. */
  templates: readonly ListingTemplate[];
  /** sort_order a NEW template gets, so it lands after the rows already there. */
  nextSortOrder: number;
  onOpenChange: (open: boolean) => void;
}

export function TemplateEditorDialog({
  open,
  template,
  nextSortOrder,
  onOpenChange,
}: TemplateEditorDialogProps) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  // A callback ref: the form lives in a portal that mounts after this
  // component's first commit, so a plain ref is still null in the effect.
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [initial] = useState(() => blankEditor(template, nextSortOrder));
  const [editor, setEditor] = useState<EditorState>(initial);
  const isDirty = useMemo(
    () => fingerprint(editor) !== fingerprint(initial),
    [editor, initial],
  );

  const save = useMutation({
    mutationFn: async (state: EditorState) => {
      const input = toInput(state);
      return state.existing
        ? updateTemplate(state.existing.id, input)
        : createTemplate(input);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    },
    onSuccess: (saved, state) => {
      onOpenChange(false);
      toast.success(
        state.existing ? `Saved "${saved.name}".` : `Created "${saved.name}".`,
      );
    },
    onError: (err) => {
      // Advice only where the edge said what went wrong: a name clash (the
      // (user_id, name) unique constraint) is fixed by renaming, a default
      // clash by reloading. A 500 gets the generic next step.
      toastError(err, "That did not save.", { nextStep: saveErrorNextStep(err) });
      if (err instanceof TemplateApiError && err.code === "template_default_conflict") {
        void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
      }
    },
  });

  // One confirm at a time: Escape pressed twice must not stack two.
  const asking = useRef(false);
  const requestClose = useCallback(async () => {
    if (save.isPending || asking.current) return;
    if (isDirty) {
      asking.current = true;
      const ok = await confirm({
        title: "Discard your changes?",
        description: "What you typed in this template has not been saved.",
        confirmLabel: "Discard",
        destructive: true,
      }).finally(() => {
        asking.current = false;
      });
      if (!ok) return;
    }
    onOpenChange(false);
  }, [confirm, isDirty, onOpenChange, save.isPending]);

  // A tab close or reload loses the draft just as surely as Escape does.
  useEffect(() => {
    if (!open || !isDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [open, isDirty]);

  // Ctrl/Cmd+Enter saves from anywhere in the form, textareas included.
  useEffect(() => {
    if (!form) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    form.addEventListener("keydown", onKey);
    return () => form.removeEventListener("keydown", onKey);
  }, [form]);

  const problem = nameProblem(editor.name);

  function submit() {
    if (save.isPending || problem !== null) return;
    save.mutate(editor);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) void requestClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editor.existing ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>
            Everything here is optional except the name. Leave a field blank
            and the template will not touch it.
          </DialogDescription>
        </DialogHeader>

        <form
          ref={setForm}
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              value={editor.name}
              maxLength={TEMPLATE_NAME_MAX}
              placeholder="e.g. Vintage denim"
              onChange={(e) => {
                const name = e.target.value;
                setEditor((s) => ({ ...s, name }));
              }}
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
              onCheckedChange={(v) => setEditor((s) => ({ ...s, isDefault: v }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-desc">Description boilerplate</Label>
            <Textarea
              id="tpl-desc"
              rows={4}
              value={editor.descriptionTemplate}
              placeholder="e.g. Ships next business day. Smoke-free home. Bundle to save."
              onChange={(e) => {
                const descriptionTemplate = e.target.value;
                setEditor((s) => ({ ...s, descriptionTemplate }));
              }}
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
                  setEditor((s) => ({
                    ...s,
                    ebayCondition: v === NO_CONDITION ? "" : v,
                  }))
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
                onChange={(e) => {
                  const ebayCategoryId = e.target.value;
                  setEditor((s) => ({ ...s, ebayCategoryId }));
                }}
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
              onChange={(e) => {
                const conditionDescription = e.target.value;
                setEditor((s) => ({ ...s, conditionDescription }));
              }}
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
                onChange={(e) => {
                  const shippingPolicyId = e.target.value;
                  setEditor((s) => ({ ...s, shippingPolicyId }));
                }}
              />
              <Input
                aria-label="Return policy ID"
                value={editor.returnPolicyId}
                placeholder="Return policy ID"
                onChange={(e) => {
                  const returnPolicyId = e.target.value;
                  setEditor((s) => ({ ...s, returnPolicyId }));
                }}
              />
              <Input
                aria-label="Payment policy ID"
                value={editor.paymentPolicyId}
                placeholder="Payment policy ID"
                onChange={(e) => {
                  const paymentPolicyId = e.target.value;
                  setEditor((s) => ({ ...s, paymentPolicyId }));
                }}
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
                    const name = e.target.value;
                    setEditor((s) => ({
                      ...s,
                      specifics: s.specifics.map((x) => (x.key === p.key ? { ...x, name } : x)),
                    }));
                  }}
                />
                <Input
                  aria-label={`Detail ${i + 1} value`}
                  value={p.value}
                  placeholder="Value"
                  onChange={(e) => {
                    const value = e.target.value;
                    setEditor((s) => ({
                      ...s,
                      specifics: s.specifics.map((x) => (x.key === p.key ? { ...x, value } : x)),
                    }));
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove detail ${i + 1}`}
                  onClick={() =>
                    setEditor((s) => ({
                      ...s,
                      specifics: s.specifics.filter((x) => x.key !== p.key),
                    }))
                  }
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditor((s) => ({ ...s, specifics: [...s.specifics, newPair()] }))}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add a detail
            </Button>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => void requestClose()}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || problem !== null}>
              {save.isPending ? "Saving..." : "Save template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
