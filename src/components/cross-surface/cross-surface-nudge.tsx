import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, X, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { crossSurfacePromosEnabled } from "@/lib/notification-preferences";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

// US-1075 — Cross-surface activation.
//
// A small, dismissable prompt that bridges the two halves of the platform:
// graders are nudged toward listing/FlipDesk, resellers toward grading. It is
//   • measurable: fires shown / clicked / dismissed events via track(), so
//     activation lift can be evaluated in PostHog;
//   • respectful: suppressed when the user has opted out of product messaging
//     (crossSurfacePromosEnabled); and
//   • non-nagging: dismissal persists per nudge type in localStorage, so once a
//     user closes a given prompt type it stays gone across sessions and items.
//
// Dismissal is keyed by `nudgeId` (the prompt *type*), not the specific item —
// closing it once opts the user out of that whole category of nudge.

const DISMISS_PREFIX = "gt:xsurface-nudge-dismissed:";

export interface CrossSurfaceNudgeProps {
  /** Stable nudge-type key. Drives dismissal persistence and event labels. */
  nudgeId: string;
  icon: LucideIcon;
  title: string;
  description: string;
  /**
   * Primary action. Provide `to` to route somewhere, or `onAction` for an
   * in-page action (e.g. scroll to the grading section on the same page).
   */
  cta: { label: string; to?: string; onAction?: () => void };
  /** Extra context attached to every event (e.g. submission / item id). */
  context?: Record<string, unknown>;
  className?: string;
}

export function CrossSurfaceNudge({
  nudgeId,
  icon: Icon,
  title,
  description,
  cta,
  context,
  className,
}: CrossSurfaceNudgeProps) {
  const { profile } = useAuth();
  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Keep context out of effect deps without stale closures.
  const contextRef = useRef(context);
  contextRef.current = context;

  const dismissKey = `${DISMISS_PREFIX}${nudgeId}`;

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(dismissKey) === "1");
    } catch {
      /* private-mode browsers throw; treat as not dismissed */
    }
    setHydrated(true);
  }, [dismissKey]);

  const promosEnabled = crossSurfacePromosEnabled(profile?.notification_preferences);
  const visible = hydrated && !dismissed && promosEnabled;

  // Measure impressions: fire once when the prompt first becomes visible.
  useEffect(() => {
    if (visible) {
      track("cross_surface_nudge_shown", {
        nudge_id: nudgeId,
        ...contextRef.current,
      });
    }
  }, [visible, nudgeId]);

  if (!visible) return null;

  function handleDismiss() {
    try {
      localStorage.setItem(dismissKey, "1");
    } catch {
      /* ignore — dismissal just won't persist */
    }
    setDismissed(true);
    track("cross_surface_nudge_dismissed", {
      nudge_id: nudgeId,
      ...contextRef.current,
    });
  }

  function handleClick() {
    track("cross_surface_nudge_clicked", {
      nudge_id: nudgeId,
      ...contextRef.current,
    });
    cta.onAction?.();
  }

  return (
    <Card className={cn("relative border-brand-red/30 bg-brand-red/5", className)}>
      <CardContent className="flex flex-col gap-3 py-4 pr-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-brand-red/10 p-2">
            <Icon className="h-5 w-5 text-brand-red-text" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {cta.to ? (
          <Button size="sm" asChild className="shrink-0">
            <Link to={cta.to} onClick={handleClick}>
              {cta.label}
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </Button>
        ) : (
          <Button size="sm" className="shrink-0" onClick={handleClick}>
            {cta.label}
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        )}
      </CardContent>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <X className="h-4 w-4" />
      </button>
    </Card>
  );
}
