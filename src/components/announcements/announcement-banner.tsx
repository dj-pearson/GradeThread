import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { X, Info, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";

// US-628: renders the single highest-priority active announcement for the
// current user. Targeting + window filtering happens server-side; this just
// shows the top one and persists a dismissal.

type Variant = "info" | "success" | "warning" | "promo";

interface ActiveAnnouncement {
  id: string;
  title: string;
  body: string;
  variant: Variant;
  cta_label: string | null;
  cta_url: string | null;
  dismissible: boolean;
  priority: number;
}

const STYLES: Record<Variant, { wrap: string; icon: typeof Info }> = {
  info: { wrap: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200", icon: Info },
  success: { wrap: "border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200", icon: CheckCircle2 },
  warning: { wrap: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200", icon: AlertTriangle },
  promo: { wrap: "border-brand-red/30 bg-brand-red/10 text-brand-night", icon: Sparkles },
};

export function AnnouncementBanner() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["announcements-active"],
    queryFn: async (): Promise<{ announcements: ActiveAnnouncement[] }> => {
      const res = await edgeFetch("/api/announcements/active", { silentGate: true });
      if (!res.ok) return { announcements: [] };
      return res.json();
    },
    staleTime: 5 * 60_000,
    // Don't blow up the dashboard if the endpoint is unavailable.
    retry: false,
  });

  const dismiss = useMutation({
    // US-3378: this used to discard the response. edgeFetch does not throw on a
    // non-2xx, so a failed dismiss resolved as a success, onSuccess invalidated,
    // and the banner simply came straight back with no explanation. That is the one
    // shape a person reads as "the X button is broken" rather than "that did not
    // save". Reading res.ok turns it into a mutation error, which is both
    // retryable and sayable.
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/announcements/${id}/dismiss`, {
        method: "POST",
        json: {},
        silentGate: true,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Could not dismiss that (HTTP ${res.status}).`);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["announcements-active"] }),
    onError: (err: Error) =>
      toast.error("Couldn't dismiss that", { description: err.message }),
  });

  const top = data?.announcements?.[0];
  if (!top) return null;

  const { wrap, icon: Icon } = STYLES[top.variant];

  return (
    <div className={cn("mb-4 flex items-start gap-3 rounded-lg border px-4 py-3", wrap)}>
      <Icon className="mt-0.5 h-5 w-5 flex-shrink-0" />
      <div className="flex-1">
        <p className="font-semibold">{top.title}</p>
        <p className="text-sm opacity-90">{top.body}</p>
        {top.cta_label && safeHref(top.cta_url) && (
          <a
            href={safeHref(top.cta_url) ?? undefined}
            className="mt-1 inline-block text-sm font-semibold underline underline-offset-2"
          >
            {top.cta_label}
          </a>
        )}
      </div>
      {top.dismissible && (
        <button
          aria-label="Dismiss"
          onClick={() => dismiss.mutate(top.id)}
          disabled={dismiss.isPending}
          className="flex-shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100 disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
