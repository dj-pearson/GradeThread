import { useEffect, useState } from "react";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useContentSettings,
  useTestWebhook,
  useUpdateContentSettings,
} from "@/hooks/use-content";

// Singleton settings page. Admin-only via the route gate.
// All inputs are debounce-free — the user clicks Save to commit (it's
// rare-touch config, not autosave-worthy).
export function ContentSettingsPage() {
  const { data: settings, isLoading } = useContentSettings();
  const save = useUpdateContentSettings();
  const test = useTestWebhook();

  // Local draft state so the user can edit without TanStack refetches
  // overwriting their typing. Synced from server when the row first loads.
  const [draft, setDraft] = useState<Partial<typeof settings> | null>(null);
  useEffect(() => {
    if (settings && draft === null) setDraft({ ...settings });
  }, [settings, draft]);

  if (isLoading || !draft) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const setField = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) =>
    setDraft((prev) => (prev ? { ...prev, [k]: v } : prev));

  return (
    <div className="space-y-6">
      <SEO title="Content Settings" />
      <div>
        <h1 className="text-2xl font-bold">Content Settings</h1>
        <p className="text-sm text-muted-foreground">
          Webhooks, autopilot, cadence, and model defaults.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Make.com webhooks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(
            [
              ["make_webhook_blog", "Blog publish", "blog"],
              ["make_webhook_social_long", "Social long (LinkedIn/Facebook)", "social_long"],
              ["make_webhook_social_short", "Social short (X/Threads)", "social_short"],
            ] as const
          ).map(([field, label, target]) => (
            <div key={field} className="space-y-1">
              <Label htmlFor={field}>{label}</Label>
              <div className="flex gap-2">
                <Input
                  id={field}
                  type="url"
                  placeholder="https://hook.make.com/..."
                  value={(draft[field] as string | null) ?? ""}
                  onChange={(e) => setField(field, e.target.value || null)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!draft[field] || test.isPending}
                  onClick={() => test.mutate(target)}
                >
                  Test
                </Button>
              </div>
              {test.data && test.variables === target && (
                <p
                  className={`text-xs ${
                    test.data.succeeded ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {test.data.succeeded
                    ? `OK — ${test.data.http_status} (${test.data.latency_ms}ms)`
                    : `Failed — ${test.data.error ?? test.data.http_status}`}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Autopilot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="font-medium">Auto-publish blog</p>
              <p className="text-xs text-muted-foreground">
                Scheduler tick will publish generated drafts immediately.
              </p>
            </div>
            <Switch
              checked={draft.auto_publish_blog ?? false}
              onCheckedChange={(v) => setField("auto_publish_blog", v)}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="font-medium">Auto-publish social</p>
              <p className="text-xs text-muted-foreground">
                Generated paired social posts publish immediately.
              </p>
            </div>
            <Switch
              checked={draft.auto_publish_social ?? false}
              onCheckedChange={(v) => setField("auto_publish_social", v)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="cadence_blog">Blog posts per day</Label>
              <Input
                id="cadence_blog"
                type="number"
                min={0}
                max={10}
                value={draft.post_cadence_per_day_blog ?? 1}
                onChange={(e) =>
                  setField(
                    "post_cadence_per_day_blog",
                    parseInt(e.target.value, 10) || 0,
                  )
                }
              />
            </div>
            <div>
              <Label htmlFor="cadence_social">Social posts per day</Label>
              <Input
                id="cadence_social"
                type="number"
                min={0}
                max={20}
                value={draft.post_cadence_per_day_social ?? 2}
                onChange={(e) =>
                  setField(
                    "post_cadence_per_day_social",
                    parseInt(e.target.value, 10) || 0,
                  )
                }
              />
            </div>
            <div>
              <Label htmlFor="min_bank">Min topics in bank</Label>
              <Input
                id="min_bank"
                type="number"
                min={1}
                max={50}
                value={draft.min_topics_in_bank ?? 3}
                onChange={(e) =>
                  setField(
                    "min_topics_in_bank",
                    parseInt(e.target.value, 10) || 1,
                  )
                }
              />
            </div>
            <div>
              <Label htmlFor="refill_batch">Topics refill batch</Label>
              <Input
                id="refill_batch"
                type="number"
                min={1}
                max={50}
                value={draft.topics_refill_batch ?? 10}
                onChange={(e) =>
                  setField(
                    "topics_refill_batch",
                    parseInt(e.target.value, 10) || 1,
                  )
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          {(
            [
              ["default_blog_model", "Blog generator"],
              ["default_social_model", "Social generator"],
              ["default_research_model", "Topic research (lightweight)"],
              ["default_image_model", "Hero image"],
            ] as const
          ).map(([field, label]) => (
            <div key={field}>
              <Label htmlFor={field}>{label}</Label>
              <Input
                id={field}
                value={(draft[field] as string) ?? ""}
                onChange={(e) => setField(field, e.target.value)}
              />
            </div>
          ))}
          <div className="col-span-2">
            <Label htmlFor="public_site_url">Public site URL</Label>
            <Input
              id="public_site_url"
              value={draft.public_site_url ?? ""}
              onChange={(e) => setField("public_site_url", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={() => draft && save.mutate(draft)}
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
