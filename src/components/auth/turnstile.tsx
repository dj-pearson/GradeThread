import { useEffect, useRef } from "react";

// US-368: Cloudflare Turnstile bot-protection widget for the auth pages
// (signup / login / password-reset). When GoTrue has captcha enabled
// (GOTRUE_SECURITY_CAPTCHA_*), it rejects any auth call without a valid token,
// so these pages render this widget and forward the token as `captchaToken`.
//
// The whole feature is gated on VITE_TURNSTILE_SITE_KEY: unset (dev / local /
// before the key is provisioned) → `captchaRequired` is false and the widget
// renders nothing, so auth keeps working. Flip it on together with the GoTrue
// secret (see supabase/config.toml + ENVIRONMENT.md), never one without the other.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** True when a captcha token must be obtained before submitting an auth form. */
export const captchaRequired = Boolean(SITE_KEY);

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
    },
  ) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

// Load the Turnstile script once, shared across every widget instance.
let scriptPromise: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null; // allow a later retry
      reject(new Error("Failed to load Turnstile"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TurnstileWidgetProps {
  /** Called with a fresh token when the challenge is solved. */
  onVerify: (token: string) => void;
  /** Called when the token expires or the widget errors (clear stored token). */
  onExpire?: () => void;
  /**
   * Change this number to force the widget to reset and issue a new token —
   * Turnstile tokens are single-use, so reset after a failed submit.
   */
  resetSignal?: number;
}

export function TurnstileWidget({ onVerify, onExpire, resetSignal }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Keep the latest callbacks in refs so the render effect runs exactly once.
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  onVerifyRef.current = onVerify;
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!SITE_KEY) return;
    let cancelled = false;
    loadTurnstile()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          theme: "auto",
          callback: (token) => onVerifyRef.current(token),
          "expired-callback": () => onExpireRef.current?.(),
          "error-callback": () => onExpireRef.current?.(),
        });
      })
      .catch(() => {
        // Network/load failure: leave the form usable but tokenless. GoTrue (when
        // captcha is on) will reject the submit with a clear error the page shows.
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // widget already gone
        }
        widgetIdRef.current = null;
      }
    };
  }, []);

  // Reset to a fresh challenge when the parent bumps resetSignal.
  useEffect(() => {
    if (resetSignal === undefined) return;
    if (widgetIdRef.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetIdRef.current);
      } catch {
        // ignore — nothing to reset yet
      }
    }
  }, [resetSignal]);

  if (!SITE_KEY) return null;
  return <div ref={containerRef} className="flex justify-center pt-1" />;
}
