import { useEffect, useState } from "react";
import { Rocket, X } from "lucide-react";

// Public launch date for GradeThread. Banner auto-hides on/after this date,
// so we don't have to remember to remove it. If launch slips again, update
// this single constant + project-company-facts memory.
const LAUNCH_DATE = new Date("2026-07-01T00:00:00Z");
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
          <span className="font-semibold">GradeThread launches July 1, 2026</span>
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
