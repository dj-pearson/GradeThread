import { useEffect, useState } from "react";
import { Rocket, X } from "lucide-react";

// Public launch date for GradeThread. The banner auto-hides on/after this date,
// so it self-disables with NO deploy needed.
//
// US-785: the date is read from VITE_LAUNCH_DATE (set in the Cloudflare Pages env)
// so it can be corrected without a code change; it falls back to this default.
// STALE-DATE RISK: if launch slips and neither VITE_LAUNCH_DATE nor this default
// is moved forward, the banner simply vanishes once the date passes (it never
// shows a wrong "X days to go"). Keep the default AHEAD of the real launch, or
// set VITE_LAUNCH_DATE — also update the project-company-facts memory.
const DEFAULT_LAUNCH_DATE = "2026-07-01T00:00:00Z";

function resolveLaunchDate(): Date {
  const raw = import.meta.env.VITE_LAUNCH_DATE;
  if (typeof raw === "string" && raw.trim()) {
    const d = new Date(raw.trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(DEFAULT_LAUNCH_DATE);
}

const LAUNCH_DATE = resolveLaunchDate();
const LAUNCH_LABEL = LAUNCH_DATE.toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const DISMISS_KEY = "gt:launch-banner-dismissed-v1";

function daysUntilLaunch(): number {
  const now = Date.now();
  const ms = LAUNCH_DATE.getTime() - now;
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export function LaunchBanner() {
  // Render nothing on the server pass (Helmet etc.) until we know the
  // localStorage state — avoids a flash that then disappears.
  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      /* private-mode browsers throw; treat as not dismissed */
    }
    setHydrated(true);
  }, []);

  if (!hydrated) return null;
  if (dismissed) return null;
  if (Date.now() >= LAUNCH_DATE.getTime()) return null;

  const days = daysUntilLaunch();

  return (
    <div className="relative w-full bg-brand-red text-white">
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-3 px-6 py-2 text-sm">
        <Rocket className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <p className="text-center">
          <span className="font-semibold">GradeThread launches {LAUNCH_LABEL}</span>
          {days > 0 && (
            <span className="ml-2 opacity-90">
              ({days} {days === 1 ? "day" : "days"} to go)
            </span>
          )}
          <span className="ml-2 hidden sm:inline opacity-90">
            — sign up now to be ready on day one.
          </span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* ignore */
          }
          setDismissed(true);
        }}
        aria-label="Dismiss launch announcement"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-white/80 hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/40"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
