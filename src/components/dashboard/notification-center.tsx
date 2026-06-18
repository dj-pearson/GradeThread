import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CheckCircle2,
  AlertTriangle,
  CreditCard,
  Info,
  CheckCheck,
  Award,
  Hourglass,
  Tag,
  DollarSign,
  ArrowRightLeft,
  Banknote,
  Handshake,
  Undo2,
} from "lucide-react";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/use-auth";
import type { NotificationRow, NotificationType } from "@/types/database";

function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case "grade_complete":
    case "grading_ready":
      return Award;
    case "grading_submitted":
      return Hourglass;
    case "dispute_update":
      return AlertTriangle;
    case "billing":
      return CreditCard;
    case "system":
      return Info;
    case "item_status_change":
      return ArrowRightLeft;
    case "listing_live":
      return Tag;
    case "sale_recorded":
      return DollarSign;
    case "payout_imported":
      return Banknote;
    case "offer_received":
      return Handshake;
    case "return_requested":
      return Undo2;
    default:
      return CheckCircle2;
  }
}

function getNotificationIconColor(type: NotificationType): string {
  switch (type) {
    case "grade_complete":
    case "grading_ready":
    case "listing_live":
    case "sale_recorded":
      return "text-emerald-600 dark:text-emerald-400";
    case "grading_submitted":
      return "text-violet-600 dark:text-violet-400";
    case "dispute_update":
      return "text-yellow-600 dark:text-yellow-400";
    case "billing":
    case "payout_imported":
      return "text-blue-600 dark:text-blue-400";
    case "item_status_change":
      return "text-sky-600 dark:text-sky-400";
    case "offer_received":
      return "text-amber-600 dark:text-amber-400";
    case "return_requested":
      return "text-rose-600 dark:text-rose-400";
    case "system":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function NotificationCenter() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const visible = useDocumentVisible();

  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as NotificationRow[];
    },
    enabled: !!user?.id,
    // Realtime INSERTs (below) are the primary delivery path; this poll is a
    // fallback. Widened to 60s and gated on tab visibility so hidden tabs stop
    // hitting the DB. (US-576)
    refetchInterval: visible ? 60000 : false,
  });

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  // Subscribe to realtime notifications
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel("notifications-realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, queryClient]);

  const markAsRead = useCallback(
    async (notificationId: string) => {
      await supabase
        .from("notifications")
        .update({ is_read: true } as never)
        .eq("id", notificationId);
      queryClient.invalidateQueries({ queryKey: ["notifications", user?.id] });
    },
    [user?.id, queryClient]
  );

  const markAllRead = useCallback(async () => {
    if (!user?.id) return;
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    await supabase
      .from("notifications")
      .update({ is_read: true } as never)
      .in("id", unreadIds);
    queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
  }, [user?.id, notifications, queryClient]);

  const handleNotificationClick = useCallback(
    async (notification: NotificationRow) => {
      if (!notification.is_read) {
        await markAsRead(notification.id);
      }
      if (notification.link) {
        setOpen(false);
        navigate(notification.link);
      }
    },
    [markAsRead, navigate]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-red px-1 text-[10px] text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <h4 className="text-sm font-semibold">Notifications</h4>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs"
              onClick={markAllRead}
            >
              <CheckCheck className="mr-1 h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>
        <Separator />
        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No notifications yet
            </div>
          ) : (
            notifications.map((notification) => {
              const Icon = getNotificationIcon(notification.type);
              const iconColor = getNotificationIconColor(notification.type);
              return (
                <button
                  key={notification.id}
                  onClick={() => handleNotificationClick(notification)}
                  className={cn(
                    "flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                    !notification.is_read && "bg-muted/30"
                  )}
                >
                  <div className={cn("mt-0.5 flex-shrink-0", iconColor)}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={cn(
                          "text-sm",
                          !notification.is_read && "font-medium"
                        )}
                      >
                        {notification.title}
                      </p>
                      {!notification.is_read && (
                        <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-brand-red" />
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                      {notification.message}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {timeAgo(notification.created_at)}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
