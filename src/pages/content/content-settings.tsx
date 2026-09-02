import { useEffect, useState } from "react";
import { SEO } from "@/components/seo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { RotateCw } from "lucide-react";
import {
  useContentSettings,
  useRetryWebhook,
  useTestWebhook,
  useUpdateContentSettings,
  useWebhookLog,
} from "@/hooks/use-content";
import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABELS } from "@/lib/constants";
import type { SocialPlatform } from "@/types/database";

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
      <LoadingRegion label="Loading content settings" className="space-y-6">
        <SkeletonRows rows={6} className="space-y-4" />
      </LoadingRegion>
    );
  }

  const setField = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) =>
    setDraft((prev) => (prev ? { ...prev, [k]: v } : prev));

  return (
    <div className="space-y-6">
      <SEO title="Content Settings" noindex />
      <PageHeader
        title="Content Settings"
        subtitle="Webhooks, autopilot, cadence, and model defaults."
      />

      <Card>
        <CardHeader>
          <CardTitle>Make.com webhooks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(
            [
              ["make_webhook_blog", "Blog publish", "blog"],
              ["make_webhook_social", "Social platform router (all platforms)", "social"],
              ["make_webhook_social_long", "Social long (LinkedIn/Facebook) — legacy fallback", "social_long"],
              ["make_webhook_social_short", "Social short (X/Threads) — legacy fallback", "social_short"],
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
                aria-label={`Test the ${label} webhook`}
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
                    test.data.succeeded ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
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
          <CardTitle>Social platforms</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Which platforms get a tailored variant generated and a publish
            webhook fired. The AI writes one post per enabled platform; the
            router webhook above dispatches each by platform.
          </p>
          {SOCIAL_PLATFORMS.map((platform) => {
            const enabled = (draft.social_platforms ?? []).includes(platform);
            return (
              <div
                key={platform}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <p className="font-medium">
                  {SOCIAL_PLATFORM_LABELS[platform]}
                </p>
                <Switch
                  aria-label={`Publish to ${SOCIAL_PLATFORM_LABELS[platform]}`}
                  checked={enabled}
                  onCheckedChange={(v) => {
                    const current = (draft.social_platforms ??
                      []) as SocialPlatform[];
                    const next = v
                      ? Array.from(new Set([...current, platform]))
                      : current.filter((p) => p !== platform);
                    setField("social_platforms", next);
                  }}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Autopilot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-destructive/50 bg-destructive/5 p-3">
            <div>
              <p className="font-medium">Pause all publishing</p>
              <p className="text-xs text-muted-foreground">
                Kill-switch: the scheduler stops publishing entirely —
                auto-publish AND scheduled drafts. Manual publishing still
                works.
              </p>
            </div>
            <Switch
              aria-label="Pause all publishing"
              checked={draft.publishing_paused ?? false}
              onCheckedChange={(v) => setField("publishing_paused", v)}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="font-medium">Auto-publish blog</p>
              <p className="text-xs text-muted-foreground">
                Scheduler tick will publish generated drafts immediately.
              </p>
            </div>
            <Switch
              aria-label="Auto-publish blog"
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
              aria-label="Auto-publish social"
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
            <div>
              <Label htmlFor="max_weekly">Max auto-publishes per week</Label>
              <Input
                id="max_weekly"
                type="number"
                min={0}
                max={100}
                value={draft.max_auto_publishes_per_week ?? 10}
                onChange={(e) =>
                  setField(
                    "max_auto_publishes_per_week",
                    parseInt(e.target.value, 10) || 0,
                  )
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Hard ceiling on social auto-posts, independent of daily
                cadence. Blog is uncapped. At the limit, new social posts
                stay in drafts.
              </p>
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

      <RecentDeliveries />
    </div>
  );
}

function RecentDeliveries() {
  const { data: deliveries = [], isLoading } = useWebhookLog();
  const retry = useRetryWebhook();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent webhook deliveries</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <LoadingRegion label="Loading webhook deliveries">
            <SkeletonRows rows={5} />
          </LoadingRegion>
        ) : deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No webhooks have been dispatched yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">When</th>
                <th className="py-2">Event</th>
                <th className="py-2">Attempt</th>
                <th className="py-2">Status</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="py-2 text-xs text-muted-foreground">
                    {new Date(d.created_at).toLocaleString()}
                  </td>
                  <td className="py-2">
                    {d.event}
                    {d.format && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        /{d.format}
                      </span>
                    )}
                  </td>
                  <td className="py-2">{d.attempt_no}</td>
                  <td className="py-2">
                    {d.succeeded ? (
                      <Badge variant="default">{d.http_status ?? "200"}</Badge>
                    ) : (
                      <Badge variant="destructive">
                        {d.http_status ?? d.error?.slice(0, 24) ?? "failed"}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {!d.succeeded && (
                      <Button
                      aria-label={`Retry the delivery that returned ${d.http_status ?? "an error"}`}
                        size="sm"
                        variant="ghost"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(d.id)}
                        title="Retry this delivery"
                      >
                        <RotateCw className="mr-1 h-3.5 w-3.5" /> Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
