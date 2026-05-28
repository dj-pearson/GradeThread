import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  acceptConsent,
  declineConsent,
  getStoredConsent,
} from "@/lib/analytics";

// Cookie-consent banner (GDPR/CCPA). Shown only until the visitor makes a
// choice; the choice persists in localStorage. Until "Accept" is clicked,
// Google Analytics stays in Consent Mode "denied" and PostHog never loads.
export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(getStoredConsent() === null);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[100] border-t bg-background/95 p-4 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          We use cookies for analytics to understand how the product is used and
          improve it. You can accept or decline. See our{" "}
          <Link to="/cookies" className="underline hover:text-foreground">
            Cookie Policy
          </Link>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              declineConsent();
              setVisible(false);
            }}
          >
            Decline
          </Button>
          <Button
            size="sm"
            className="bg-brand-navy"
            onClick={() => {
              acceptConsent();
              setVisible(false);
            }}
          >
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
