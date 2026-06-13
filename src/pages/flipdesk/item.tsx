import { useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { supabase } from "@/lib/supabase";
import { useItemsFull } from "@/hooks/use-items-full";
import { ItemCanvas } from "@/components/flipdesk/item-canvas";
import { ConditionIndexValueHint } from "@/components/flipdesk/condition-index-value-hint";
import { GradeRoiHint } from "@/components/flipdesk/grade-roi-hint";
import { DisclosurePanel } from "@/components/disclosure/disclosure-panel";
import { ITEM_STATUS_LABELS } from "@/lib/constants";

// Deep-linkable item detail page. The canvas itself is shared with the
// quick-look dialog opened from list rows.
export function FlipdeskItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Shared items_full read — single source of truth across FlipDesk (US-419).
  const { data: items = [], isLoading } = useItemsFull();

  const item = useMemo(
    () => items.find((it) => it.id === id) ?? null,
    [items, id],
  );

  function goBack() {
    navigate("/dashboard/flipdesk/items");
  }

  if (isLoading) {
    return (
      <LoadingRegion label="Loading item" className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </LoadingRegion>
    );
  }

  if (!item) {
    return (
      <div className="space-y-3 py-12 text-center">
        <div className="text-sm text-muted-foreground">Item not found.</div>
        <Button variant="outline" onClick={goBack}>
          Back to items
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          aria-label="Back to items"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/dashboard/flipdesk/items" className="hover:text-foreground">
            Items
          </Link>
          <span>/</span>
          <span className="truncate font-medium text-foreground">
            {item.item_title || "Untitled item"}
          </span>
        </nav>
        <Badge variant="outline" className="ml-auto font-normal">
          {ITEM_STATUS_LABELS[item.status]}
        </Badge>
      </div>

      {/* US-856: proactive grade-ROI nudge from the seller's own sold history.
          CTA scrolls to the canvas grade section. Suppresses itself once the
          item is graded or when the category sample is too thin. */}
      <GradeRoiHint
        category={item.category}
        grade={item.grade_value}
        priceHint={item.target_price ?? item.list_price ?? item.purchase_price}
        onGrade={() => {
          const el = document.getElementById("canvas-grading");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      {/* On the page, Save keeps the user here (the query refetches); only
          Cancel and the back button navigate away. */}
      <ItemCanvas item={item} onCancel={goBack} />

      {/* US-848: grade-anchored value from the public Condition Index curve. */}
      <ConditionIndexValueHint
        brand={item.brand}
        category={item.category}
        title={item.item_title}
        grade={item.grade_value}
      />

      {/* Auto-Disclosure Engine: condition & flaws + annotated defect photos. */}
      <DisclosurePanel itemId={item.id} />

      {/* US-150: per-listing opt-out from the price-drop/promo scheduler. */}
      <AutomationOptOutCard itemId={item.id} />
    </div>
  );
}

// items_full doesn't expose the flag, so read/write inventory_items directly
// (RLS scopes both to the caller's own rows).
function AutomationOptOutCard({ itemId }: { itemId: string }) {
  const queryClient = useQueryClient();

  const { data: excluded, isLoading } = useQuery({
    queryKey: ["item_automation_optout", itemId],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("exclude_from_automations")
        .eq("id", itemId)
        .single();
      if (error) throw error;
      return (data as { exclude_from_automations: boolean })
        .exclude_from_automations;
    },
  });

  const toggle = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase
        .from("inventory_items")
        .update({ exclude_from_automations: next } as never)
        .eq("id", itemId);
      if (error) throw error;
      return next;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["item_automation_optout", itemId], next);
      toast.success(
        next
          ? "Excluded from automations — rules will skip this item."
          : "Automations re-enabled for this item.",
      );
    },
    onError: () => toast.error("Couldn't update the automation setting."),
  });

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 pt-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <Zap className="h-4 w-4 text-brand-red-text" />
            Exclude from automations
          </div>
          <p className="text-sm text-muted-foreground">
            Price-drop, promo, and end-listing rules from the Automations page
            will skip this item.
          </p>
        </div>
        <Switch
          checked={excluded ?? false}
          onCheckedChange={(next) => toggle.mutate(next)}
          disabled={isLoading || toggle.isPending}
          aria-label="Exclude from automations"
        />
      </CardContent>
    </Card>
  );
}
