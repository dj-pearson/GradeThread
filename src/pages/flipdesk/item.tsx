import { useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { ItemCanvas } from "@/components/flipdesk/item-canvas";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import type { ItemFullRow } from "@/types/database";

// Deep-linkable item detail page. The canvas itself is shared with the
// quick-look dialog opened from list rows.
export function FlipdeskItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["items_full", user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ItemFullRow[]> => {
      const { data, error } = await (
        supabase.from as unknown as (
          name: "items_full",
        ) => {
          select: (cols: string) => {
            order: (
              col: string,
              opts?: { ascending?: boolean },
            ) => Promise<{ data: ItemFullRow[] | null; error: Error | null }>;
          };
        }
      )("items_full")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const item = useMemo(
    () => items.find((it) => it.id === id) ?? null,
    [items, id],
  );

  function goBack() {
    navigate("/dashboard/flipdesk/items");
  }

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Loading item…
      </div>
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

      {/* On the page, Save keeps the user here (the query refetches); only
          Cancel and the back button navigate away. */}
      <ItemCanvas item={item} onCancel={goBack} />
    </div>
  );
}
