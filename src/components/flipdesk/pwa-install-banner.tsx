import { useEffect, useState } from "react";
import { Download, X, Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ensureServiceWorker, type BeforeInstallPromptEvent } from "@/lib/pwa";

const DISMISS_KEY = "flipdesk-pwa-install-dismissed";

// One-time install prompt banner for the FlipDesk PWA. Surfaces only when the
// browser reports the app is installable and the user hasn't dismissed it.
export function PwaInstallBanner() {
  const [promptEvent, setPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    ensureServiceWorker();
    if (localStorage.getItem(DISMISS_KEY)) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!promptEvent) return null;

  async function install() {
    if (!promptEvent) return;
    setInstalling(true);
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } finally {
      setInstalling(false);
      setPromptEvent(null);
    }
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, "1");
    setPromptEvent(null);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-brand-navy/30 bg-brand-navy/5 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-brand-navy/10">
          <Smartphone className="h-5 w-5 text-brand-navy dark:text-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">Install FlipDesk on this device</p>
          <p className="text-xs text-muted-foreground">
            Catalog items faster — works offline on thrift trips with spotty
            signal.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void install()} disabled={installing}>
          {installing ? (
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-3 w-3" />
          )}
          Install
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
