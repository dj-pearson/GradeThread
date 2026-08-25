import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { EmailCategorySwitches } from "@/components/admin/email-category-switches";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { SlidersHorizontal, RefreshCw, Loader2, Save, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

// US-884 — DB-backed system settings registry editor.
//
// Renders /api/admin/settings grouped by category as type-aware controls
// (toggle / number / textarea / json), each with inline validation, a Save that
// PUTs the one key (super_admin + MFA step-up server-side) and a "Reset to
// default". The settings are seeded operational constants (review confidence
// threshold, rate-limit caps, health thresholds) tunable without a deploy.

type ValueType = "number" | "bool" | "string" | "json";

interface Setting {
  key: string;
  value: unknown;
  value_type: ValueType;
  default_value: unknown;
  description: string | null;
  category: string;
  updated_at: string;
  updated_by: string | null;
}

interface CategoryGroup {
  category: string;
  settings: Setting[];
}

interface SettingsResponse {
  groups: CategoryGroup[];
  total: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

// The edit-form representation of a value: bools stay boolean, everything else
// is edited as text (json gets pretty-printed) and validated on save.
function toDraft(s: Setting): string | boolean {
  if (s.value_type === "bool") return s.value === true;
  if (s.value_type === "json") {
    try {
      return JSON.stringify(s.value, null, 2);
    } catch {
      return String(s.value ?? "");
    }
  }
  return s.value == null ? "" : String(s.value);
}

function defaultDraft(s: Setting): string | boolean {
  return toDraft({ ...s, value: s.default_value });
}

// Validate a draft against its type. Returns the parsed value or an error.
function validateDraft(
  type: ValueType,
  draft: string | boolean,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (type === "bool") return { ok: true, value: draft === true };
  if (type === "number") {
    const n = Number(draft);
    if (typeof draft !== "string" || draft.trim() === "" || !Number.isFinite(n)) {
      return { ok: false, error: "Enter a finite number." };
    }
    return { ok: true, value: n };
  }
  if (type === "string") return { ok: true, value: String(draft) };
  // json
  try {
    return { ok: true, value: JSON.parse(String(draft)) };
  } catch {
    return { ok: false, error: "Invalid JSON." };
  }
}

function CATEGORY_LABEL(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function SettingEditor({
  setting,
  onSaved,
  onStepUpRequired,
}: {
  setting: Setting;
  onSaved: () => void;
  onStepUpRequired: (retry: () => void) => void;
}) {
  const [draft, setDraft] = useState<string | boolean>(() => toDraft(setting));
  const [saving, setSaving] = useState(false);

  // Re-sync the draft when the server value changes (after a refetch).
  useEffect(() => {
    setDraft(toDraft(setting));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setting.value, setting.value_type]);

  const validation = validateDraft(setting.value_type, draft);
  const original = toDraft(setting);
  const dirty = draft !== original;
  const isDefault = JSON.stringify(draft) === JSON.stringify(defaultDraft(setting));

  async function save() {
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }
    setSaving(true);
    try {
      const res = await edgeFetch(`/api/admin/settings/${encodeURIComponent(setting.key)}`, {
        method: "PUT",
        json: { value: validation.value },
        silentGate: true,
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && (j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        onStepUpRequired(() => void save());
        return;
      }
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Save failed");
        return;
      }
      toast.success(`Updated ${setting.key}`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b py-4 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="text-sm font-semibold">{setting.key}</code>
            <Badge variant="outline" className="text-[10px] uppercase">
              {setting.value_type}
            </Badge>
            {isDefault && (
              <span className="text-[10px] text-muted-foreground">default</span>
            )}
          </div>
          {setting.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{setting.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving || isDefault}
            onClick={() => setDraft(defaultDraft(setting))}
            title="Reset to default"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Default
          </Button>
          <Button size="sm" disabled={saving || !dirty || !validation.ok} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>

      {/* US-2335: all four branches below are the same control — this
          setting's value — so they share one name, built from the key. The
          key is displayed above as a row heading, not as a field label, so
          there is nothing to associate with htmlFor. */}
      <div className="max-w-xl">
        {setting.value_type === "bool" ? (
          <div className="flex items-center gap-2">
            <Switch
              aria-label={`${setting.key} value`}
              checked={draft === true}
              onCheckedChange={(checked) => setDraft(checked)}
            />
            <span className="text-sm text-muted-foreground">{draft === true ? "Enabled" : "Disabled"}</span>
          </div>
        ) : setting.value_type === "json" ? (
          <Textarea
            aria-label={`${setting.key} value`}
            value={String(draft)}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            spellCheck={false}
            className={cn("font-mono text-xs", !validation.ok && "border-destructive")}
          />
        ) : setting.value_type === "number" ? (
          <Input
            aria-label={`${setting.key} value`}
            type="number"
            value={String(draft)}
            onChange={(e) => setDraft(e.target.value)}
            step="any"
            className={cn("max-w-[200px]", !validation.ok && "border-destructive")}
          />
        ) : (
          <Input
            aria-label={`${setting.key} value`}
            value={String(draft)}
            onChange={(e) => setDraft(e.target.value)}
            className={cn(!validation.ok && "border-destructive")}
          />
        )}
        {!validation.ok && (
          <p className="mt-1 text-xs text-destructive">{validation.error}</p>
        )}
      </div>
    </div>
  );
}

export function AdminSettingsRegistryPage() {
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const query = useQuery({
    queryKey: ["admin-settings-registry"],
    queryFn: () => getJson<SettingsResponse>("/api/admin/settings"),
  });

  function handleStepUpRequired(retryFn: () => void) {
    setRetry(() => retryFn);
    setStepUpOpen(true);
  }

  const data = query.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings Registry"
        subtitle="Tune platform thresholds &amp; toggles without a deploy. Changes are audited and require a fresh second factor."
        icon={SlidersHorizontal}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        }
      />

      {/* US-2854: named kill switches for one registry row. Above the generic
          editor because it is the control an operator reaches for mid-incident,
          and the raw JSON row below is the thing they should not have to find. */}
      <EmailCategorySwitches onStepUpRequired={handleStepUpRequired} />

      {query.isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-destructive">
            {(query.error as Error)?.message ?? "Failed to load settings."}
          </CardContent>
        </Card>
      ) : data && data.groups.length > 0 ? (
        <div className="space-y-6">
          {data.groups.map((group) => (
            <Card key={group.category}>
              <CardHeader>
                <CardTitle className="text-base">{CATEGORY_LABEL(group.category)}</CardTitle>
                <CardDescription>
                  {group.settings.length} setting{group.settings.length === 1 ? "" : "s"}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                {group.settings.map((s) => (
                  <SettingEditor
                    key={s.key}
                    setting={s}
                    onSaved={() => void query.refetch()}
                    onStepUpRequired={handleStepUpRequired}
                  />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No settings registered.
          </CardContent>
        </Card>
      )}

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}
