import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type AdminNotification,
  useAdminNotifications,
} from "@/hooks/use-admin-notifications";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const m = Math.round((Date.now() - then) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// US-909: admin notification bell. Shows the unread count, lists recent
// notifications, marks them read (one or all), and deep-links to the relevant
// admin surface. Fed by the ops-event pipeline + ticket assignment.
export function AdminNotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // US-2803: the route has supported ?unread_only=true since US-909 and no
  // caller ever passed it. Local state, not persisted: a filter that outlives
  // the popover is a filter somebody forgets is on and then reports the feed
  // as empty.
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data } = useAdminNotifications(unreadOnly);
  const notifications = data?.notifications ?? [];
  const unread = data?.unread_count ?? 0;

  async function markRead(body: { id?: string; all?: boolean }) {
    try {
      const res = await edgeFetch("/api/admin/notifications", {
        method: "PATCH",
        json: body,
        silentGate: true,
      });
      if (res.ok) {
        // PREFIX match, which is what makes the US-2803 filter safe to add: the
        // key gained a third element (unreadOnly) and this still invalidates
        // both the filtered and unfiltered caches, so marking one read cannot
        // leave the other view showing it as unread.
        await qc.invalidateQueries({ queryKey: ["admin-notifications", "feed"] });
      }
    } catch {
      // Best-effort — a failed mark-read shouldn't surface to the operator.
    }
  }

  function openNotification(n: AdminNotification) {
    if (!n.is_read) void markRead({ id: n.id });
    if (n.link) navigate(n.link);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex h-9 w-9 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent/50"
          aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-red px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setUnreadOnly((v) => !v)}
              aria-pressed={unreadOnly}
              className={`text-xs font-medium hover:underline ${
                unreadOnly ? "text-brand-red-text" : "text-muted-foreground"
              }`}
            >
              {unreadOnly ? "Showing unread" : "Unread only"}
            </button>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markRead({ all: true })}
                className="text-xs font-medium text-brand-red-text hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>
        </div>
        <DropdownMenuSeparator />
        {notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            You're all caught up.
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => openNotification(n)}
                className={`flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent/50 ${
                  n.is_read ? "" : "bg-brand-red/5"
                }`}
              >
                <span className="flex w-full items-start gap-2">
                  {!n.is_read && (
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-red" />
                  )}
                  <span className="flex-1">{n.body}</span>
                </span>
                <span className="pl-3.5 text-xs text-muted-foreground">
                  {relativeTime(n.created_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
