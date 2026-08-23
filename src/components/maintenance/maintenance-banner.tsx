import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { X, Megaphone, Wrench, Ban } from "lucide-react";
import { cn } from "@/lib/utils";

// US-887: app-shell maintenance notice. Reads the PUBLIC /api/maintenance/active
// endpoint and renders one bar per effective window, reusing the announcement
// banner styling. A 'banner' window is dismissible (per-session, by id);
// 'read_only' and 'blocked' windows are NON-dismissible — they communicate an
// active restriction the user can't wave away.

type Mode = "banner" | "read_only" | "blocked";
type Scope = "platform" | "grading" | "flipdesk" | "checkout";

interface ActiveWindow {
  id: string;
  scope: Scope;
  mode: Mode;
  message: string;
  starts_at: string | null;
  ends_at: string | null;
}

const STYLES: Record<Mode, { wrap: string; icon: typeof Wrench; label: string }> = {
  banner: {
    wrap: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200",
    icon: Megaphone,
    label: "Notice",
  },
  read_only: {
    wrap: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
    icon: Wrench,
    label: "Read-only maintenance",
  },
  blocked: {
    wrap: "border-brand-red/30 bg-brand-red/10 text-brand-night dark:text-red-200",
    icon: Ban,
    label: "Maintenance in progress",
  },
};

const SCOPE_LABEL: Record<Scope, string> = {
  platform: "GradeThread",
  grading: "Grading",
  flipdesk: "FlipDesk",
  checkout: "Checkout & billing",
};

const DISMISS_KEY = "gt:maintenance-dismissed";

function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function MaintenanceBanner() {
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed());

  const { data } = useQuery({
    queryKey: ["maintenance-active"],
    queryFn: async (): Promise<{ windows: ActiveWindow[] }> => {
      const res = await edgeFetch("/api/maintenance/active", { silentGate: true });
      if (!res.ok) return { windows: [] };
      return res.json();
    },
    // Maintenance state should surface promptly — poll on a short interval.
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev).add(id);
      try {
        sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
      } catch {
        // sessionStorage unavailable (private mode) — dismissal is in-memory only.
      }
      return next;
    });
  }

  const windows = (data?.windows ?? []).filter(
    (w) => !(w.mode === "banner" && dismissed.has(w.id)),
  );
  if (windows.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {windows.map((w) => {
        const { wrap, icon: Icon, label } = STYLES[w.mode];
        const canDismiss = w.mode === "banner";
        return (
          <div
            key={w.id}
            role="status"
            className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", wrap)}
          >
            <Icon className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">
                {label}
                {w.scope !== "platform" && (
                  <span className="font-normal opacity-80"> · {SCOPE_LABEL[w.scope]}</span>
                )}
              </p>
              <p className="text-sm opacity-90">{w.message}</p>
              {w.ends_at && (
                <p className="mt-0.5 text-xs opacity-70">
                  Expected to end {new Date(w.ends_at).toLocaleString()}
                </p>
              )}
            </div>
            {canDismiss && (
              <button
                aria-label={`Dismiss notice: ${w.message}`}
                onClick={() => dismiss(w.id)}
                className="flex-shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
