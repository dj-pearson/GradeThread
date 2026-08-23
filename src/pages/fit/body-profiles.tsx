import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Ruler, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useMeasurementPrefs } from "@/stores/measurement-prefs";
import {
  BODY_MEASUREMENT_FIELDS,
  MAX_PROFILE_NAME,
  normalizeBodyMeasurements,
  validateProfileName,
  type BodyProfile,
} from "@/lib/body-profile";
import type { BodyProfileRow } from "@/types/database";

// US-1777: buyer body-profile manager. Saves body measurements per authenticated
// user (RLS-protected) so a fit check is one tap. Reads/writes go directly
// through the authenticated Supabase client — RLS (auth.uid() = user_id) is the
// only access boundary. Measurements are stored in INCHES; the in/cm toggle is a
// display preference converted on the way in and out.

const CM_PER_IN = 2.54;

function toDisplay(inches: number | undefined, unit: "in" | "cm"): string {
  if (inches == null) return "";
  return (unit === "cm" ? inches * CM_PER_IN : inches).toFixed(1).replace(/\.0$/, "");
}
function toInches(raw: string, unit: "in" | "cm"): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return unit === "cm" ? n / CM_PER_IN : n;
}

interface Draft {
  id: string | null;
  name: string;
  values: Record<string, string>; // display-unit strings, keyed by measurement key
}

function emptyDraft(): Draft {
  return { id: null, name: "", values: {} };
}

function draftFromProfile(p: BodyProfile, unit: "in" | "cm"): Draft {
  const values: Record<string, string> = {};
  for (const f of BODY_MEASUREMENT_FIELDS) {
    values[f.key] = toDisplay(p.measurements[f.key], unit);
  }
  return { id: p.id, name: p.name, values };
}

export function BodyProfilesPage() {
  const userId = useAuthStore((s) => s.user?.id) ?? null;
  const { unit, setUnit } = useMeasurementPrefs();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: profiles = [], isLoading } = useQuery<BodyProfile[]>({
    queryKey: ["body-profiles", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("body_profiles")
        .select("id, name, measurements, is_default")
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data as Pick<BodyProfileRow, "id" | "name" | "measurements" | "is_default">[]).map((r) => ({
        id: r.id,
        name: r.name,
        measurements: normalizeBodyMeasurements(r.measurements),
        is_default: r.is_default,
      }));
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["body-profiles", userId] });

  async function save() {
    if (!draft || !userId) return;
    const name = validateProfileName(draft.name);
    if (!name) {
      toast.error("Give this profile a name.");
      return;
    }
    // Convert display-unit inputs → inches, then normalize/clamp.
    const inches: Record<string, number> = {};
    for (const f of BODY_MEASUREMENT_FIELDS) {
      const raw = draft.values[f.key]?.trim();
      if (!raw) continue;
      const v = toInches(raw, unit);
      if (v != null) inches[f.key] = v;
    }
    const measurements = normalizeBodyMeasurements(inches);
    setSaving(true);
    try {
      if (draft.id) {
        const { error } = await supabase
          .from("body_profiles")
          .update({ name, measurements } as never)
          .eq("id", draft.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("body_profiles")
          .insert({ user_id: userId, name, measurements, is_default: profiles.length === 0 } as never);
        if (error) throw error;
      }
      toast.success("Measurements saved.");
      setDraft(null);
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string, name: string) {
    const ok = await confirm({
      title: `Delete "${name}"?`,
      description:
        "This permanently removes this measurement profile. This can't be undone.",
      confirmLabel: "Delete profile",
      destructive: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("body_profiles").delete().eq("id", id);
    if (error) {
      toast.error("Couldn't delete that profile.");
      return;
    }
    toast.success("Profile deleted.");
    invalidate();
  }

  async function makeDefault(id: string) {
    // Clear the current default, then set the new one (two owner-scoped updates).
    await supabase.from("body_profiles").update({ is_default: false } as never).eq("is_default", true);
    const { error } = await supabase.from("body_profiles").update({ is_default: true } as never).eq("id", id);
    if (error) {
      toast.error("Couldn't set default.");
      return;
    }
    invalidate();
  }

  const unitLabel = unit === "cm" ? "cm" : "in";
  const editingExisting = useMemo(() => Boolean(draft?.id), [draft]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader
        className="mb-6"
        icon={Ruler}
        title="My measurements"
        subtitle="Save your body measurements once, then check whether an item will fit in a tap. Private to your account."
        actions={
          <div className="flex items-center gap-1 rounded-lg border p-1 text-sm">
            {(["in", "cm"] as const).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`rounded px-2 py-1 ${unit === u ? "bg-brand-navy text-white dark:bg-foreground dark:text-background" : "text-muted-foreground"}`}
              >
                {u}
              </button>
            ))}
          </div>
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {profiles.length > 0 && (
            <ul className="mb-6 space-y-3">
              {profiles.map((p) => (
                <li key={p.id} className="flex items-center justify-between rounded-xl border p-4">
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      {p.name}
                      {p.is_default && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand-navy/10 px-2 py-0.5 text-xs text-brand-navy dark:bg-foreground/10 dark:text-foreground">
                          <Star className="h-3 w-3" /> Default
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {Object.keys(p.measurements).length} measurement
                      {Object.keys(p.measurements).length === 1 ? "" : "s"} saved
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!p.is_default && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Make ${p.name} the default profile`}
                        onClick={() => makeDefault(p.id)}
                      >
                        Set default
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Edit ${p.name}`}
                      onClick={() => setDraft(draftFromProfile(p, unit))}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => remove(p.id, p.name)}
                    >
                      <Trash2 className="h-4 w-4 text-brand-red-text" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {draft ? (
            <div className="rounded-xl border bg-card p-5">
              <h2 className="text-lg font-semibold">{editingExisting ? "Edit profile" : "New profile"}</h2>
              <div className="mt-4">
                <Label htmlFor="bp-name">Profile name</Label>
                <Input
                  id="bp-name"
                  value={draft.name}
                  maxLength={MAX_PROFILE_NAME}
                  placeholder="e.g. Me, or a gift recipient"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="mt-1"
                />
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                {BODY_MEASUREMENT_FIELDS.map((f) => (
                  <div key={f.key}>
                    <Label htmlFor={`bp-${f.key}`}>
                      {f.label} <span className="text-muted-foreground">({unitLabel})</span>
                    </Label>
                    <Input
                      id={`bp-${f.key}`}
                      inputMode="decimal"
                      value={draft.values[f.key] ?? ""}
                      onChange={(e) => setDraft({ ...draft, values: { ...draft.values, [f.key]: e.target.value } })}
                      className="mt-1"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">{f.guidance}</p>
                  </div>
                ))}
              </div>
              <div className="mt-6 flex gap-3">
                <Button onClick={() => void save()} disabled={saving}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save measurements
                </Button>
                <Button variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setDraft(emptyDraft())}>
              <Plus className="mr-1 h-4 w-4" /> Add a profile
            </Button>
          )}
        </>
      )}
    </div>
  );
}
