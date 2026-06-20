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

export function useAdminNotifications() {
  return useQuery({
    queryKey: ["admin-notifications", "feed"],
    queryFn: async (): Promise<AdminNotificationsResult> => {
      const res = await edgeFetch("/api/admin/notifications?limit=30", {
        silentGate: true,
      });
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
