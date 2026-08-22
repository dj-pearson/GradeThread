import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";

// US-909: the admin notification center feed (assigned tickets, critical ops
// events, job failures). Backed by /api/admin/notifications, scoped server-side
// to the calling admin. Light poll for the bell badge.

export interface AdminNotification {
  id: string;
  type: string;
  body: string;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

export interface AdminNotificationsResult {
  notifications: AdminNotification[];
  unread_count: number;
}

/**
 * US-2803: `unreadOnly` reaches the route's `?unread_only=true`, which has been
 * implemented and documented in its own comment since US-909 and which no
 * caller ever passed. The bell offers it as a toggle.
 *
 * The unread COUNT is unaffected by the filter — the route computes it over the
 * whole feed — so the badge keeps meaning "unread", not "unread in the current
 * view", which is what a filter on a badge would quietly turn it into.
 */
export function useAdminNotifications(unreadOnly = false) {
  return useQuery({
    queryKey: ["admin-notifications", "feed", unreadOnly],
    queryFn: async (): Promise<AdminNotificationsResult> => {
      const res = await edgeFetch(
        `/api/admin/notifications?limit=30${unreadOnly ? "&unread_only=true" : ""}`,
        { silentGate: true },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load notifications");
      return {
        notifications: (json.notifications ?? []) as AdminNotification[],
        unread_count: Number(json.unread_count ?? 0),
      };
    },
    staleTime: 30_000,
    refetchInterval: 45_000,
  });
}
