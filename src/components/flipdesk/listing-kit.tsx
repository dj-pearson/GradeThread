import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Images,
  Puzzle,
  Wand2,
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
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  charStatus,
  getMarketplaceSpec,
  manualKitPlatforms,
  type FieldSpec,
  type MarketplacePlatform,
} from "@/lib/marketplace-specs";
import {
  type PlatformKitVariant,
  useGeneratePlatformFields,
} from "@/hooks/use-autolister";

// Copy-paste targets: the no-API platforms (Poshmark/Mercari/Grailed) plus
// Depop until its partner API is live (US-712/713/714). Shopify + eBay push via
// their adapters, so they're not copy-paste targets.
const KIT_PLATFORMS: MarketplacePlatform[] = [
  "poshmark",
  "mercari",
  "depop",
  "grailed",
].filter((p) =>
  p === "depop" ? true : manualKitPlatforms().includes(p as MarketplacePlatform),
) as MarketplacePlatform[];

// Where to send the seller to create the listing manually.
const NEW_LISTING_URL: Partial<Record<MarketplacePlatform, string>> = {
  poshmark: "https://poshmark.com/create-listing",
  mercari: "https://www.mercari.com/sell/",
  depop: "https://www.depop.com/sell/",
  grailed: "https://www.grailed.com/sell/",
};

// Maps a registry field key to its value in a generated variant.
function fieldValue(key: string, v: PlatformKitVariant): string {
  switch (key) {
    case "title":
      return v.title;
    case "description":
      return v.description;
    case "category":
    case "department":
    case "productType":
      return v.category;
    case "condition":
      return v.condition?.label ?? "";
    case "brand":
    case "designer":
    case "vendor":
      return v.brand ?? "";
    case "color":
      return v.color ?? "";
    case "size":
      return v.size ?? "";
    case "tags":
      return v.tags.join(" ");
    case "price":
    case "originalPrice":
      return v.price ? String(v.price) : "";
    case "nwt":
      return v.condition?.value === "NWT" ? "Yes" : "No";
    default:
      return "";
  }
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy — your browser blocked clipboard access.");
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      disabled={!text}
      onClick={async () => {
        await copy(text, label);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

interface KitFieldProps {
  field: FieldSpec;
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
}

function KitField({ field, value, editable, onChange }: KitFieldProps) {
  const status = charStatus(value, field.maxLength);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium">
          {field.label}
          {field.required && <span className="ml-0.5 text-brand-red">*</span>}
        </Label>
        <div className="flex items-center gap-1">
          {field.maxLength != null && (
            <span
              className={cn(
                "text-[11px] tabular-nums",
                status.over ? "font-semibold text-brand-red" : "text-muted-foreground",
              )}
            >
              {status.length}/{field.maxLength}
            </span>
          )}
          <CopyButton text={value} label={field.label} />
        </div>
      </div>
      {editable && field.multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[88px] text-sm"
        />
      ) : editable ? (
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="text-sm" />
      ) : (
        <div className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {value || <span className="text-muted-foreground">—</span>}
        </div>
      )}
    </div>
  );
}

function PlatformPanel({
  platform,
  variant,
  photoCount,
}: {
  platform: MarketplacePlatform;
  variant: PlatformKitVariant | undefined;
  photoCount: number;
}) {
  const spec = getMarketplaceSpec(platform);
  // Local edits to the free-text fields, keyed by field key.
  const [edits, setEdits] = useState<Record<string, string>>({});
  if (!spec) return null;

  if (!variant) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Not generated yet — click “Generate for all marketplaces” above.
      </p>
    );
  }

  // title/description are editable; everything else is copy-only display.
  const editableKeys = new Set(["title", "description"]);
  const valueOf = (f: FieldSpec) =>
    edits[f.key] ?? fieldValue(f.key, variant);

  const issues = variant.validation?.issues ?? [];
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  const copyAll = () => {
    const block = spec.fields
      .map((f) => `${f.label}: ${valueOf(f)}`)
      .join("\n");
    void copy(block, `${spec.label} listing`);
  };

  return (
    <div className="space-y-3">
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="space-y-1 rounded-md border p-2 text-xs">
          {errors.map((i, idx) => (
            <div key={`e${idx}`} className="flex items-start gap-1.5 text-brand-red">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{i.message}</span>
            </div>
          ))}
          {warnings.map((i, idx) => (
            <div key={`w${idx}`} className="flex items-start gap-1.5 text-amber-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={copyAll}>
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Copy all fields
        </Button>
        {NEW_LISTING_URL[platform] && (
          <Button type="button" variant="outline" size="sm" asChild>
            <a href={NEW_LISTING_URL[platform]} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open {spec.label}
            </a>
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          title="Requires the GradeThread Lister browser extension (US-716) — coming soon"
        >
          <Puzzle className="mr-1.5 h-3.5 w-3.5" />
          Send to extension
        </Button>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Images className="h-3.5 w-3.5" />
          {photoCount} photo{photoCount === 1 ? "" : "s"} (max {spec.maxPhotos})
        </span>
      </div>

      <div className="space-y-3">
        {spec.fields.map((f) => (
          <KitField
            key={f.key}
            field={f}
            value={valueOf(f)}
            editable={editableKeys.has(f.key)}
            onChange={(v) => setEdits((prev) => ({ ...prev, [f.key]: v }))}
          />
        ))}
      </div>
    </div>
  );
}

export function ListingKit({ itemId }: { itemId: string }) {
  const qc = useQueryClient();
  const gen = useGeneratePlatformFields();

  // The eBay draft row carries platform_fields + lets us seed the kit.
  const { data } = useQuery({
    queryKey: ["platform-fields", itemId],
    queryFn: async () => {
      const { data: row } = await supabase
        .from("listings")
        .select("id, platform_fields")
        .eq("inventory_item_id", itemId)
        .eq("platform", "ebay")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (row ?? null) as { id: string; platform_fields: Record<string, unknown> | null } | null;
    },
  });

  const { data: photoCount = 0 } = useQuery({
    queryKey: ["item-photo-count", itemId],
    queryFn: async () => {
      const { count } = await supabase
        .from("item_photos")
        .select("id", { count: "exact", head: true })
        .eq("inventory_item_id", itemId);
      return count ?? 0;
    },
  });

  // Seed from persisted platform_fields; overlay anything just generated.
  const variants = useMemo(() => {
    const map: Record<string, PlatformKitVariant> = {};
    const stored = (data?.platform_fields ?? {}) as Record<string, Record<string, unknown>>;
    for (const [plat, raw] of Object.entries(stored)) {
      map[plat] = normalize(plat, raw);
    }
    for (const v of gen.data?.variants ?? []) {
      map[v.platform] = v;
    }
    return map;
  }, [data?.platform_fields, gen.data]);

  const hasAny = Object.keys(variants).length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Cross-list copy kit</CardTitle>
            <CardDescription>
              AI-tailored fields for marketplaces without API push — copy each field
              into Poshmark, Mercari, Depop, or Grailed.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              gen.mutate(
                { itemId, platforms: KIT_PLATFORMS },
                {
                  onSuccess: () => {
                    toast.success("Marketplace fields generated");
                    void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
                  },
                },
              );
            }}
            disabled={gen.isPending}
          >
            <Wand2 className="mr-1.5 h-4 w-4" />
            {gen.isPending
              ? "Generating…"
              : hasAny
                ? "Regenerate"
                : "Generate for all marketplaces"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={KIT_PLATFORMS[0]}>
          <TabsList className="flex-wrap">
            {KIT_PLATFORMS.map((p) => {
              const spec = getMarketplaceSpec(p);
              const v = variants[p];
              const hasErr = v ? !v.validation?.ok : false;
              return (
                <TabsTrigger key={p} value={p} className="gap-1.5">
                  {spec?.label ?? p}
                  {hasErr && <span className="h-1.5 w-1.5 rounded-full bg-brand-red" />}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {KIT_PLATFORMS.map((p) => (
            <TabsContent key={p} value={p} className="mt-4">
              {getMarketplaceSpec(p)?.pushMechanism === "manual" || p === "depop" ? (
                <div className="mb-3">
                  <Badge variant="outline" className="text-[11px]">
                    {p === "depop" ? "API pending — copy-paste for now" : "No API — copy-paste / extension"}
                  </Badge>
                </div>
              ) : null}
              <PlatformPanel platform={p} variant={variants[p]} photoCount={photoCount} />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

// Normalizes a persisted platform_fields entry (no `platform` key) into the
// PlatformKitVariant shape the panel renders.
function normalize(platform: string, raw: Record<string, unknown>): PlatformKitVariant {
  const cond = raw.condition as { value?: string; label?: string } | null | undefined;
  const validation = (raw.validation ?? { platform, ok: true, issues: [] }) as
    PlatformKitVariant["validation"];
  return {
    platform,
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    condition: cond && cond.value ? { value: cond.value, label: cond.label ?? cond.value } : null,
    category: typeof raw.category === "string" ? raw.category : "",
    brand: (raw.brand as string | null) ?? null,
    color: (raw.color as string | null) ?? null,
    size: (raw.size as string | null) ?? null,
    price: typeof raw.price === "number" ? raw.price : 0,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    validation,
  };
}
