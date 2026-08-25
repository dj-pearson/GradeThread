import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TEMPLATES_QUERY_KEY,
  listTemplates,
  preferredTemplate,
  templateChanges,
  type ListingTemplate,
} from "@/lib/flipdesk-templates";

// US-2877. The composer's saved-template picker.
//
// iOS's PublishDialog has had one since US-674 (`templateStore` + a picker that
// pre-fills the draft). The web composer had no idea saved templates existed:
// its own `applyTemplate` applies a DESCRIPTION_TEMPLATES garment preset, which
// is our writing rather than the seller's, and shares nothing but the word.
//
// FILL-EMPTY, never overwrite. Same rule as the AutoLister bulk grid since
// US-555, and the reason the button SAYS what it skipped: a preset that
// silently leaves five fields alone reads as a preset that did not work.

export interface SavedTemplateTargets {
  description: string;
  ebayCondition: string;
  conditionDescription: string;
  categoryId: string;
  shippingPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

export function SavedTemplatePicker({
  current,
  onApply,
}: {
  /** What the composer holds right now, so "already filled" is honest. */
  current: SavedTemplateTargets;
  /** Only the fields that were empty. The composer sets exactly these. */
  onApply: (
    patch: Partial<SavedTemplateTargets>,
    specifics: Record<string, string>,
    template: ListingTemplate,
  ) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  const templatesQuery = useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: listTemplates,
    staleTime: 5 * 60_000,
  });
  const templates = templatesQuery.data ?? [];

  // The default template is offered first, exactly as iOS does.
  const chosen =
    templates.find((t) => t.id === selectedId) ?? preferredTemplate(templates);

  if (templatesQuery.isLoading || templatesQuery.isError) return null;

  if (templates.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Save the parts you type on every listing once, and start from them
            next time.
          </p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/dashboard/flipdesk/templates">Make a template</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  function apply() {
    if (!chosen) return;
    const changes = templateChanges(chosen, current as unknown as Record<string, string>);
    const patch: Partial<SavedTemplateTargets> = {};
    const left: string[] = [];
    for (const c of changes) {
      if (c.wouldOverwrite) {
        left.push(c.label);
        continue;
      }
      patch[c.field as keyof SavedTemplateTargets] = c.value;
    }
    setSkipped(left);
    onApply(patch, chosen.item_specifics ?? {}, chosen);
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <Select
              value={chosen?.id ?? ""}
              onValueChange={(v) => {
                setSelectedId(v);
                setSkipped([]);
              }}
            >
              <SelectTrigger aria-label="Saved template">
                <SelectValue placeholder="Pick a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {t.is_default ? " (default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={apply} disabled={!chosen}>
            Use template
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {skipped.length > 0
            ? `Filled in the empty fields. Left ${skipped.join(", ")} alone because you had already written something there.`
            : "Fills in anything you have left blank. It never writes over what you have typed."}
        </p>
      </CardContent>
    </Card>
  );
}
