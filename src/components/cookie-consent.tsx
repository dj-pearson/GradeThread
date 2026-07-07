import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  acceptAll,
  DENY_ALL,
  getConsent,
  hasConsentDecision,
  rejectAll,
  saveConsent,
  type ConsentState,
} from "@/lib/analytics";
import { useConsentRegime } from "@/hooks/use-consent-regime";
import { onOpenCookiePreferences } from "@/lib/cookie-preferences";

// Location-aware cookie consent (privacy epic).
//
//   opt-in (EU/UK/ROW/unknown): nothing non-essential runs until the visitor
//     actively chooses. Granular Analytics + Marketing toggles; "Reject all" is
//     exactly as prominent as "Accept all" (ePrivacy/EDPB requirement).
//   opt-out (US/CCPA): a slim notice + a "Your Privacy Choices" manager; Global
//     Privacy Control is honored automatically as a universal opt-out.
export function CookieConsent() {
  const { regime, isGPC, ready } = useConsentRegime();
  const [decided, setDecided] = useState(true); // assume decided until mounted
  const [manualOpen, setManualOpen] = useState(false); // reopened via footer
  const [showManager, setShowManager] = useState(false); // granular toggles shown
  const [prefs, setPrefs] = useState<ConsentState>(() => getConsent() ?? DENY_ALL);

  // Read the stored decision on mount (localStorage isn't available during SSR).
  useEffect(() => {
    setDecided(hasConsentDecision());
    const stored = getConsent();
    if (stored) setPrefs(stored);
  }, []);

  // Honor Global Privacy Control in the US opt-out regime: GPC legally counts as
  // a universal opt-out, so we record a reject and never nag the visitor.
  useEffect(() => {
    if (!ready || decided) return;
    if (regime === "opt-out" && isGPC) {
      rejectAll();
      setDecided(true);
    }
  }, [ready, decided, regime, isGPC]);

  // Footer "Cookie settings" reopens the manager even after a decision.
  useEffect(() =>
    onOpenCookiePreferences(() => {
      setPrefs(getConsent() ?? DENY_ALL);
      setManualOpen(true);
      setShowManager(true);
    }), []);

  const close = useCallback(() => {
    setManualOpen(false);
    setShowManager(false);
    setDecided(true);
  }, []);

  // Nothing to show: decided and not manually reopened, or geo not resolved yet
  // (so an EU visitor never flashes the US variant).
  const visible = manualOpen || (ready && !decided);
  if (!visible) return null;

  const optIn = regime === "opt-in";
  const managerOpen = showManager || optIn; // opt-in always shows granular toggles

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Cookie preferences"
      className="fixed inset-x-0 bottom-0 z-[100] border-t bg-background/95 p-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <p className="text-sm text-muted-foreground lg:max-w-2xl">
            {optIn ? (
              <>
                We use cookies for analytics and, where enabled, marketing. We
                only set non-essential cookies with your consent. Choose which to
                allow — see our{" "}
                <Link to="/cookies" className="underline hover:text-foreground">
                  Cookie Policy
                </Link>
                .
              </>
            ) : (
              <>
                We use cookies for analytics and marketing. You can opt out of the
                sale or sharing of your personal information at any time. See our{" "}
                <Link to="/cookies" className="underline hover:text-foreground">
                  Cookie Policy
                </Link>{" "}
                and{" "}
                <Link to="/privacy" className="underline hover:text-foreground">
                  Privacy Policy
                </Link>
                .
              </>
            )}
          </p>

          {/* Primary actions. In opt-in, Reject and Accept are equally prominent. */}
          <div className="flex shrink-0 flex-wrap gap-2">
            {optIn ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    rejectAll();
                    close();
                  }}
                >
                  Reject all
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    acceptAll();
                    close();
                  }}
                >
                  Accept all
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowManager((v) => !v)}
                  aria-expanded={showManager}
                >
                  Your Privacy Choices
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    acceptAll();
                    close();
                  }}
                >
                  Accept
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Granular category manager. Always visible in opt-in; toggle-revealed
            in opt-out via "Your Privacy Choices". */}
        {managerOpen && (
          <fieldset className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Manage cookies
            </legend>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked
                disabled
                className="mt-0.5 h-4 w-4 flex-shrink-0 accent-brand-navy"
                aria-label="Strictly necessary cookies (always on)"
              />
              <span>
                <span className="font-medium text-foreground">
                  Strictly necessary
                </span>{" "}
                — required for sign-in, security, and remembering this choice.
                Always on.
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={prefs.analytics}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, analytics: e.target.checked }))
                }
                className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-brand-red"
              />
              <span>
                <span className="font-medium text-foreground">Analytics</span> —
                helps us understand how the product is used so we can improve it
                (Google Analytics, PostHog).
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={prefs.marketing}
                onChange={(e) =>
                  setPrefs((p) => ({ ...p, marketing: e.target.checked }))
                }
                className="mt-0.5 h-4 w-4 flex-shrink-0 cursor-pointer accent-brand-red"
              />
              <span>
                <span className="font-medium text-foreground">Marketing</span> —
                lets us measure and personalize advertising.
              </span>
            </label>

            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  saveConsent(prefs);
                  close();
                }}
              >
                Save choices
              </Button>
            </div>
          </fieldset>
        )}
      </div>
    </div>
  );
}
