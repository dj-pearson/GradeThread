import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/ui/page-header";
import { Bell, RefreshCw, Loader2 } from "lucide-react";
import {
  NOTIFICATION_EVENT_CATALOG,
  NOTIFICATION_TYPES,
} from "@/lib/notification-preferences";
import type { NotificationChannel, NotificationType } from "@/types/database";

// US-1058 — admin notification event catalog.
//
// Read-only. Lists every notifiable event, the preference category that gates it
// (sourced server-side from notify.ts PREF_KEY — the SAME gate used at send
// time, so this honors the preference gate end-to-end), the channels that
// category supports, and the delivery volume from the notifications table.

interface CatalogEntry {
  type: NotificationType;
  pref_key: string | null;
  total: number;
  last_30d: number;
}

interface CatalogResponse {
  catalog: CatalogEntry[];
  total_volume: number;
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: "Email",
  in_app: "In-app",
  push: "Push",
};

// prefKey → category label + supported channels, from the shared settings model.
const CATEGORY_BY_KEY = new Map(
  NOTIFICATION_TYPES.map((t) => [t.key as string, t]),
);
const EVENT_META_BY_TYPE = new Map(
  NOTIFICATION_EVENT_CATALOG.map((e) => [e.type, e]),
);

async function fetchCatalog(): Promise<CatalogResponse> {
  const res = await edgeFetch("/api/admin/notifications/catalog");
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error ?? "Failed to load the notification catalog.");
  }
  return json as CatalogResponse;
}

export function AdminNotificationsPage() {
  const query = useQuery({
    queryKey: ["admin-notification-catalog"],
    queryFn: fetchCatalog,
    staleTime: 60_000,
  });

  const rows = query.data?.catalog ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notification Catalog"
        subtitle={
          <>
            Every notifiable event, the preference category that gates it, the
            channels it supports, and how often it has fired. Users control
            each category under Settings → Notifications.
          </>
        }
        icon={Bell}
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

      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
          <CardDescription>
            {query.data
              ? `${rows.length} event types · ${query.data.total_volume.toLocaleString()} notifications delivered all-time.`
              : "Loading…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : query.isError ? (
            <p className="py-8 text-center text-sm text-destructive">
              {(query.error as Error)?.message ??
                "Failed to load the notification catalog."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Preference category</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead className="text-right">Last 30d</TableHead>
                  <TableHead className="text-right">All-time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const meta = EVENT_META_BY_TYPE.get(row.type);
                  const category = row.pref_key
                    ? CATEGORY_BY_KEY.get(row.pref_key)
                    : undefined;
                  const channels = category?.channels ?? [];
                  return (
                    <TableRow key={row.type}>
                      <TableCell>
                        <div className="font-medium">
                          {meta?.label ?? row.type}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {meta?.description ?? (
                            <code className="text-[11px]">{row.type}</code>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.pref_key ? (
                          <Badge variant="secondary">
                            {category?.label ?? row.pref_key}
                          </Badge>
                        ) : (
                          <Badge variant="outline">Always on</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {channels.length > 0 ? (
                            channels.map((ch) => (
                              <Badge key={ch} variant="outline">
                                {CHANNEL_LABELS[ch]}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              In-app
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.last_30d.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.total.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
