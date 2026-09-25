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
import { EbayCategorySearch } from "@/components/flipdesk/ebay-category-search";
import { PolicySelectRow } from "@/components/flipdesk/composer/policies-card";
import { TemplateGradePreview } from "@/components/flipdesk/template-grade-preview";
import {
  useEbayCategoryAspects,
  useEbayCategoryConditions,
  useEbayConnection,
  useEbayPolicies,
} from "@/hooks/use-ebay";
import { toastError } from "@/lib/toast-error";
import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";
import {
  CONDITION_NOTE_MAX,
  DESCRIPTION_TEMPLATE_MAX,
  SPECIFIC_NAME_MAX,
  SPECIFIC_VALUE_MAX,
  SPECIFICS_MAX,
  TEMPLATES_QUERY_KEY,
  TEMPLATE_NAME_MAX,
  TemplateApiError,
  type ListingTemplate,
  type TemplateInput,
  createTemplate,
  duplicateNameProblem,
  nameProblem,
  normalizeInput,
  saveErrorNextStep,
  specificRowProblems,
  updateTemplate,
} from "@/lib/flipdesk-templates";
import { cn } from "@/lib/utils";

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

/** "n / max", turning destructive in the last tenth before the cap. */
function CharCount({ id, value, max }: { id: string; value: string; max: number }) {
  const near = value.length >= max * 0.9;
  return (
    <p
      id={id}
      className={cn("text-right text-xs tabular-nums", near ? "text-destructive" : "text-muted-foreground")}
    >
      {value.length} / {max}
    </p>
  );
}

function staticConditionLabel(value: string): string {
  return EBAY_CONDITION_OPTIONS.find((o) => o.value === value)?.label ?? value;
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
  /** Start a NEW template prefilled from this row (Duplicate). */
  copyOf?: ListingTemplate | null;
  /** The name the copy starts with, already made unique by the caller. */
  copyName?: string;
  /** View only: every field disabled and no Save (a workspace viewer). */
  readOnly?: boolean;
}

export function TemplateEditorDialog({
  open,
  template,
  templates,
  nextSortOrder,
  onOpenChange,
  copyOf = null,
  copyName,
  readOnly = false,
}: TemplateEditorDialogProps) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  // A callback ref: the form lives in a portal that mounts after this
  // component's first commit, so a plain ref is still null in the effect.
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [initial] = useState<EditorState>(() =>
    copyOf && !template
      ? {
          ...blankEditor(copyOf),
          existing: null,
          name: copyName ?? copyOf.name,
          isDefault: false,
          sortOrder: nextSortOrder,
        }
      : blankEditor(template, nextSortOrder),
  );
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

  // eBay-backed pickers. Everything degrades to typed ids when eBay is not
  // connected, so a seller can still build a template before connecting.
  const connectionQuery = useEbayConnection();
  const connected = !!connectionQuery.data;
  const policiesQuery = useEbayPolicies(connected);

  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  const [changingCategory, setChangingCategory] = useState(false);
  const [enterCategoryId, setEnterCategoryId] = useState(false);
  const setCategory = (id: string, path: string | null) => {
    setCategoryPath(path);
    setEditor((s) => ({ ...s, ebayCategoryId: id }));
  };
  const categoryView: "chosen" | "search" | "id" =
    !connected || enterCategoryId
      ? "id"
      : editor.ebayCategoryId && !changingCategory
        ? "chosen"
        : "search";
  const categoryInputId = categoryView === "search" ? "tpl-cat-search" : "tpl-cat";
  // A stored id has no path on the row; the aspects lookup names it.
  const aspectsQuery = useEbayCategoryAspects(
    connected && editor.ebayCategoryId && !categoryPath ? editor.ebayCategoryId : null,
  );
  const categoryName = editor.ebayCategoryId
    ? categoryPath ?? aspectsQuery.data?.categoryName ?? null
    : null;
  const categoryLabel = categoryName ?? `Category ${editor.ebayCategoryId}`;

  // Only the conditions eBay accepts in the chosen leaf, when it restricts them.
  const conditionsQuery = useEbayCategoryConditions(
    editor.ebayCategoryId || null,
    connected,
  );
  const restricted = conditionsQuery.data?.restricted === true;
  const conditionOptions: ReadonlyArray<{ value: string; label: string }> = restricted
    ? conditionsQuery.data!.options
    : EBAY_CONDITION_OPTIONS;
  const conditionRejected =
    restricted &&
    editor.ebayCondition !== "" &&
    !conditionOptions.some((o) => o.value === editor.ebayCondition);

  // The name error waits until the field was left or a save was tried, so a
  // fresh "New template" does not open on a red sentence.
  const [nameTouched, setNameTouched] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const problem =
    nameProblem(editor.name) ??
    duplicateNameProblem(editor.name, templates, editor.existing?.id ?? null);
  const showProblem = nameTouched && problem !== null;
  const rowProblems = specificRowProblems(editor.specifics);

  function submit() {
    if (save.isPending || readOnly) return;
    if (problem !== null) {
      setNameTouched(true);
      nameInput.current?.focus();
      return;
    }
    if (rowProblems.size > 0) {
      const first = editor.specifics.find((p) => rowProblems.has(p.key));
      if (first) document.getElementById(`tpl-detail-${first.key}-name`)?.focus();
      return;
    }
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
          <DialogTitle>
            {readOnly ? editor.name : editor.existing ? "Edit template" : "New template"}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? "You can view this template. Only people who manage inventory in this workspace can change it."
              : "Everything here is optional except the name. Leave a field blank and the template will not touch it."}
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
          <fieldset disabled={readOnly} className="min-w-0 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              ref={nameInput}
              // A new template has nothing else to start from.
              autoFocus={editor.existing === null && !readOnly}
              aria-invalid={showProblem || undefined}
              aria-describedby={showProblem ? "tpl-name-error" : undefined}
              onBlur={() => setNameTouched(true)}
              value={editor.name}
              maxLength={TEMPLATE_NAME_MAX}
              placeholder="e.g. Vintage denim"
              onChange={(e) => {
                const name = e.target.value;
                setEditor((s) => ({ ...s, name }));
              }}
            />
            {showProblem && (
              <p id="tpl-name-error" className="text-sm text-destructive">
                {problem}
              </p>
            )}
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
              maxLength={DESCRIPTION_TEMPLATE_MAX}
              aria-describedby="tpl-desc-count"
              value={editor.descriptionTemplate}
              placeholder="e.g. Ships next business day. Smoke-free home. Bundle to save."
              onChange={(e) => {
                const descriptionTemplate = e.target.value;
                setEditor((s) => ({ ...s, descriptionTemplate }));
              }}
            />
            <CharCount
              id="tpl-desc-count"
              value={editor.descriptionTemplate}
              max={DESCRIPTION_TEMPLATE_MAX}
            />
            <p className="text-sm text-muted-foreground">
              Added after the listing's own description. It never replaces
              what is already written.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={categoryInputId}>eBay category</Label>
            {categoryView === "chosen" ? (
              <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{categoryLabel}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setChangingCategory(true)}
                >
                  Change
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Clear category"
                  onClick={() => {
                    setCategory("", null);
                    setChangingCategory(false);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : categoryView === "search" ? (
              <>
                <EbayCategorySearch
                  inputId="tpl-cat-search"
                  query={categoryQuery}
                  onQueryChange={setCategoryQuery}
                  onPick={(sug) => {
                    setCategory(sug.categoryId, sug.categoryTreePath);
                    setChangingCategory(false);
                    setCategoryQuery("");
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => setEnterCategoryId(true)}
                  >
                    Enter an ID instead
                  </Button>
                  {editor.ebayCategoryId && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      onClick={() => setChangingCategory(false)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <Input
                  id="tpl-cat"
                  inputMode="numeric"
                  value={editor.ebayCategoryId}
                  placeholder="Optional. e.g. 57990"
                  onChange={(e) => {
                    // eBay category ids are digits; the server refuses anything else.
                    const id = e.target.value.replace(/\D/g, "");
                    setCategory(id, null);
                  }}
                />
                {connected && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => {
                      setEnterCategoryId(false);
                      setChangingCategory(true);
                    }}
                  >
                    Search categories instead
                  </Button>
                )}
              </>
            )}
          </div>

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
              <SelectTrigger id="tpl-condition" aria-invalid={conditionRejected || undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CONDITION}>No default</SelectItem>
                {conditionOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
                {conditionRejected && (
                  <SelectItem value={editor.ebayCondition}>
                    {staticConditionLabel(editor.ebayCondition)}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {conditionRejected && (
              <p className="text-sm text-destructive">
                eBay does not accept this condition in {categoryName ?? "this category"}.
                Pick one from the list.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tpl-cond-note">Condition note</Label>
            <Textarea
              id="tpl-cond-note"
              rows={2}
              maxLength={CONDITION_NOTE_MAX}
              aria-describedby="tpl-cond-note-count"
              value={editor.conditionDescription}
              placeholder="Optional. e.g. Measured flat, see photos for wear."
              onChange={(e) => {
                const conditionDescription = e.target.value;
                setEditor((s) => ({ ...s, conditionDescription }));
              }}
            />
            <CharCount
              id="tpl-cond-note-count"
              value={editor.conditionDescription}
              max={CONDITION_NOTE_MAX}
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
            {connected && !policiesQuery.isError ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <PolicySelectRow
                  id="tpl-policy-shipping"
                  label="Shipping"
                  type="fulfillment"
                  value={editor.shippingPolicyId || null}
                  onChange={(v) => setEditor((s) => ({ ...s, shippingPolicyId: v ?? "" }))}
                  policies={policiesQuery.data?.policies}
                  defaultLabel="Account default"
                  markDefault
                />
                <PolicySelectRow
                  id="tpl-policy-payment"
                  label="Payment"
                  type="payment"
                  value={editor.paymentPolicyId || null}
                  onChange={(v) => setEditor((s) => ({ ...s, paymentPolicyId: v ?? "" }))}
                  policies={policiesQuery.data?.policies}
                  defaultLabel="Account default"
                  markDefault
                />
                <PolicySelectRow
                  id="tpl-policy-return"
                  label="Returns"
                  type="return"
                  value={editor.returnPolicyId || null}
                  onChange={(v) => setEditor((s) => ({ ...s, returnPolicyId: v ?? "" }))}
                  policies={policiesQuery.data?.policies}
                  defaultLabel="Account default"
                  markDefault
                />
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {connected
                    ? "Your eBay policies did not load, so type their IDs instead."
                    : "Connect eBay to pick policies by name. Until then you can type their IDs."}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Input
                    aria-label="Shipping policy ID"
                    inputMode="numeric"
                    value={editor.shippingPolicyId}
                    placeholder="Shipping policy ID"
                    onChange={(e) => {
                      const shippingPolicyId = e.target.value;
                      setEditor((s) => ({ ...s, shippingPolicyId }));
                    }}
                  />
                  <Input
                    aria-label="Return policy ID"
                    inputMode="numeric"
                    value={editor.returnPolicyId}
                    placeholder="Return policy ID"
                    onChange={(e) => {
                      const returnPolicyId = e.target.value;
                      setEditor((s) => ({ ...s, returnPolicyId }));
                    }}
                  />
                  <Input
                    aria-label="Payment policy ID"
                    inputMode="numeric"
                    value={editor.paymentPolicyId}
                    placeholder="Payment policy ID"
                    onChange={(e) => {
                      const paymentPolicyId = e.target.value;
                      setEditor((s) => ({ ...s, paymentPolicyId }));
                    }}
                  />
                </div>
              </>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <Label>Item details</Label>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Details that are the same on every listing this template
                makes, like Brand or Country of manufacture.
              </p>
            </div>
            {editor.specifics.map((p, i) => {
              const rowProblem = rowProblems.get(p.key);
              const errId = `tpl-detail-${p.key}-error`;
              return (
                <div key={p.key} className="space-y-1">
                  <div className="flex gap-2">
                    <Input
                      id={`tpl-detail-${p.key}-name`}
                      aria-label={`Detail ${i + 1} name`}
                      aria-invalid={rowProblem ? true : undefined}
                      aria-describedby={rowProblem ? errId : undefined}
                      maxLength={SPECIFIC_NAME_MAX}
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
                      aria-invalid={rowProblem ? true : undefined}
                      aria-describedby={rowProblem ? errId : undefined}
                      maxLength={SPECIFIC_VALUE_MAX}
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
                  {rowProblem && (
                    <p id={errId} className="text-sm text-destructive">
                      {rowProblem}
                    </p>
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              // eBay takes at most SPECIFICS_MAX item specifics per listing.
              disabled={editor.specifics.length >= SPECIFICS_MAX}
              onClick={() => setEditor((s) => ({ ...s, specifics: [...s.specifics, newPair()] }))}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add a detail
            </Button>
          </div>

          <TemplateGradePreview
            ebayCondition={editor.ebayCondition}
            conditionDescription={editor.conditionDescription}
            descriptionTemplate={editor.descriptionTemplate}
          />
          </fieldset>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => void requestClose()}
              disabled={save.isPending}
            >
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {/* Enabled even with a name problem: pressing it shows the problem
                and puts the cursor on the field, which a greyed-out button
                never explains. */}
            {!readOnly && (
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving..." : "Save template"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
