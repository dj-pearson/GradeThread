import { Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import {
  extensionStoreUrl,
  isExtensionInstalled,
  isFirefoxUserAgent,
} from "@/lib/lister-extension";
import { extensionCtaFor, type ExtensionCtaCopy } from "@/lib/seo/extension-cta-copy";

// US-9210: the extension is the top of the funnel. One line about what it does
// on the site the reader is about to visit, and a button to the right store.
// Renders nothing when the extension is already here, or when no store is
// configured (local dev), or when the page has no copy of its own.

export function ExtensionInstallCta({
  path,
  copy,
  className,
}: {
  /** The page path; the copy is looked up from it unless `copy` is given. */
  path: string;
  copy?: ExtensionCtaCopy | null;
  className?: string;
}) {
  const resolved = copy === undefined ? extensionCtaFor(path) : copy;
  const url = extensionStoreUrl();
  if (!resolved || !url || isExtensionInstalled()) return null;
  const firefox = typeof navigator !== "undefined" && isFirefoxUserAgent(navigator.userAgent);
  return (
    <section className={className ?? "px-6 py-10"}>
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 rounded-2xl bg-muted/40 p-5">
        <div className="flex items-start gap-3">
          <Puzzle className="mt-0.5 h-5 w-5 shrink-0 text-brand-navy dark:text-foreground" />
          <p className="max-w-xl text-sm text-foreground">{resolved.does}</p>
        </div>
        <Button asChild size="sm">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() =>
              track("extension_install_cta_click", { page: path, store: firefox ? "firefox" : "chrome" })
            }
          >
            {firefox ? "Add to Firefox" : "Add to Chrome"}
          </a>
        </Button>
      </div>
    </section>
  );
}
