import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Wand2,
  Save,
  Loader2,
  Plus,
  Award,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  DESCRIPTION_TEMPLATES,
  interpolateDescription,
  suggestTitle,
  titleKeywords,
  templateGroupFor,
} from "@/lib/listing-templates";
import { cn } from "@/lib/utils";
import type { ItemFullRow, ListingInsert } from "@/types/database";

const TITLE_MAX = 80;

export function FlipdeskComposerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [initialised, setInitialised] = useState(false);

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

  // Seed the fields once the item loads.
  useEffect(() => {
    if (item && !initialised) {
      setTitle(item.item_title?.slice(0, TITLE_MAX) ?? "");
      setInitialised(true);
    }
  }, [item, initialised]);

  const keywords = item ? titleKeywords(item) : [];
  const group = item ? templateGroupFor(item) : "generic";

  function applyTemplate() {
    if (!item) return;
    setDescription(
      interpolateDescription(DESCRIPTION_TEMPLATES[group], item),
    );
    toast.info(`Applied the ${group} template.`);
  }

  function appendKeyword(kw: string) {
    const next = title.trim() ? `${title.trim()} ${kw}` : kw;
    setTitle(next.slice(0, TITLE_MAX));
  }

  async function saveDraft() {
    if (!item) return;
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    setSaving(true);
    try {
      const payload: ListingInsert = {
        inventory_item_id: item.id,
        platform: "ebay",
        listing_status: "draft",
        listing_price: item.target_price ?? item.list_price ?? 0,
        listing_title: title.trim(),
        listing_description: description.trim() || null,
        is_active: false,
      };

      // Update the existing draft listing if there is one, else insert.
      if (item.listing_id && item.listing_status === "draft") {
        const { error } = await supabase
          .from("listings")
          .update(payload as never)
          .eq("id", item.listing_id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("listings")
          .insert(payload as never);
        if (error) throw error;
      }

      const { error: sErr } = await supabase
        .from("inventory_items")
        .update({ status: "drafted" } as never)
        .eq("id", item.id);
      if (sErr) throw sErr;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("Draft saved.");
      navigate("/dashboard/flipdesk/listings?tab=drafts");
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
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
        <Button variant="outline" onClick={() => navigate(-1)}>
          Go back
        </Button>
      </div>
    );
  }

  const titleLen = title.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Listing composer
          </h1>
          <p className="text-sm text-muted-foreground">
            Draft an eBay-ready title and description for "{item.item_title}".
          </p>
        </div>
      </div>

      {item.grade_value != null && (
        <div className="flex items-center gap-2 rounded-md border border-brand-navy/30 bg-brand-navy/5 p-3 text-sm">
          <Award className="h-4 w-4 text-brand-navy" />
          <span>
            Graded {item.grade_value.toFixed(1)}/10
            {item.grade_label ? ` · ${item.grade_label}` : ""}. The grade and
            certificate link are embedded when you apply a template.
          </span>
        </div>
      )}

      {/* Title */}
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>
            eBay caps titles at {TITLE_MAX} characters. Lead with the brand.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Input
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brand Item Size Category"
            />
            <span
              className={cn(
                "absolute right-2 top-1/2 -translate-y-1/2 text-[10px] tabular-nums",
                titleLen >= TITLE_MAX
                  ? "font-semibold text-destructive"
                  : titleLen > 70
                    ? "text-amber-600"
                    : "text-muted-foreground",
              )}
            >
              {titleLen}/{TITLE_MAX}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTitle(suggestTitle(item))}
            >
              <Wand2 className="mr-2 h-3 w-3" />
              Suggest title
            </Button>
            {keywords.map((kw) => (
              <button
                key={kw}
                type="button"
                onClick={() => appendKeyword(kw)}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
              >
                <Plus className="h-3 w-3" />
                {kw}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Description */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Description</CardTitle>
              <CardDescription>
                Apply the{" "}
                <Badge variant="outline" className="capitalize">
                  {group}
                </Badge>{" "}
                template, then edit freely.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={applyTemplate}>
              <Wand2 className="mr-2 h-3 w-3" />
              Apply template
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={16}
            placeholder="Apply the template above, or write your own."
            className="font-mono text-xs"
          />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(-1)} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={saveDraft} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save draft
        </Button>
      </div>
    </div>
  );
}
