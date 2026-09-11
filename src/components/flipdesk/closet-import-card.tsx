import { useState } from "react";
import { Chrome, Loader2, Shirt } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useExtensionSetup } from "@/hooks/use-extension-setup";
import {
  CLOSET_IMPORT_PLATFORMS,
  closetImportDisclosureFor,
  FREE_CLOSET_IMPORT_ROWS,
  type ClosetImportPlatform,
} from "@/lib/marketplace-disclosure";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import {
  closetImportCapNotice,
  closetImportFailureText,
  extensionStoreUrl,
  sendClosetImport,
} from "@/lib/lister-extension";
import { track } from "@/lib/analytics";

// US-9201: pull a seller's existing Poshmark or Mercari closet into FlipDesk.
//
// Every competitor starts onboarding with "import your listings"; a seller
// with a full closet will not move without it. eBay, Shopify and CSV imports
// exist; this is the extension-channel one, and it is shaped by what the
// extension may do: read a closet page the seller already has open, when
// asked, and nothing else. So the card says "open your closet in another tab"
// before it offers the button, and the button's failure sentences come from
// the extension, which is the thing that knows why nothing was read.
//
// US-3263 CHANGED WHO SEES IT, and the reasoning is worth keeping.
//
// It used to render only when the extension was installed AND the account had
// an active paid plan, on the principle that a seller should not meet a button
// that would refuse them. In practice the two people it hid from were the
// seller still deciding whether to pay and the seller who had NOT yet installed
// the extension -- and to both of them the entire feature simply did not
// exist. There was no button and no sentence. The import that would have
// answered "will this work with my closet" was the one thing they could not
// find.
//
// So: no plan renders the card with the free bound stated, and no extension
// renders an install step instead of nothing. The server still decides how many
// rows an account may import; this card only ever tells the truth about it.
//
// WHY THE BOUND IS STATED CONDITIONALLY RATHER THAN GATED ON A PLAN. The first
// cut showed that sentence only when `setup.sellerEnabled` was false, and
// `setup.sellerEnabled` is the EXTENSION's answer to GT_PING. An install that
// holds no account token gets the anonymous entitlements, which carry
// sellerEnabled:false whatever the account pays (US-3295) -- so a Business
// seller who had simply never connected the extension was told they were on the
// free plan. Telling someone who already pays that they do not is the exact
// mistake US-3295 was filed to fix. The sentence now names its own condition
// and is true for every reader.

export interface ClosetImportStart {
  runId: string;
  platform: ClosetImportPlatform;
  totalRows: number;
  newRows: number;
  knownRows: number;
  /** The extension's own install time, for the install-to-first-item number. */
  installedAt: string | null;
}

interface Props {
  disabled?: boolean;
  onStarted: (start: ClosetImportStart) => void;
}

/** The 80% warning the gate emits: CAP_80;kind=activeListings;used=N;limit=M */
function describePlanWarning(header: string): string | null {
  const m = /used=(\d+);limit=(\d+)/.exec(header);
  if (!m) return null;
  return `You are at ${m[1]} of ${m[2]} live listings on your plan after this import.`;
}

export function ClosetImportCard({ disabled, onStarted }: Props) {
  const { data: setup } = useExtensionSetup();
  const [busy, setBusy] = useState<ClosetImportPlatform | null>(null);

  // Still loading the ping: render nothing rather than flash an install prompt
  // at somebody who already has it.
  if (!setup) return null;

  const platformNames = CLOSET_IMPORT_PLATFORMS.map(
    (p) => MARKETPLACE_LABELS[p],
  ).join(", ");

  if (!setup.installed) {
    const url = extensionStoreUrl();
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shirt className="h-5 w-5" />
            Import my closet
          </CardTitle>
          <CardDescription>
            Your {platformNames} listings can come in without retyping them. The
            reading is done by the GradeThread browser extension, in a tab you
            open yourself, so it needs the extension installed first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => {
              track("closet_import_install_prompted", {});
              if (url) window.open(url, "_blank", "noopener,noreferrer");
            }}
            disabled={!url}
          >
            <Chrome className="mr-2 h-4 w-4" />
            {url ? "Get the extension" : "Extension not available yet"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  async function run(platform: ClosetImportPlatform) {
    setBusy(platform);
    track("closet_import_started", { platform });
    try {
      const res = await sendClosetImport(platform);
      const result = res.result ?? null;
      if (res.ok && result?.run_id) {
        onStarted({
          runId: result.run_id,
          platform,
          totalRows: result.total_rows ?? 0,
          newRows: result.new_rows ?? 0,
          knownRows: result.known_rows ?? 0,
          installedAt: res.installedAt ?? null,
        });
        const known = result.known_rows ?? 0;
        toast.success(
          `Read ${result.total_rows ?? 0} listings from your ${MARKETPLACE_LABELS[platform]} closet` +
            (known > 0 ? ` (${known} already here, they will be updated)` : "") +
            ". You can leave this page; the import keeps going.",
        );
        // US-3263: never let a bounded import look like a whole one. The
        // sentence depends on WHICH bound bit -- the flat per-read one, or what
        // is left of this account's own live-listing cap -- so it is built in
        // one place and tested there.
        const capNotice = closetImportCapNotice(result);
        if (capNotice) toast.warning(capNotice, { duration: 12_000 });
        const warn = result.plan_warning ? describePlanWarning(result.plan_warning) : null;
        if (warn) toast.warning(warn, { duration: 12_000 });
        return;
      }
      if (result?.error === "CAP_REACHED") {
        toast.error(
          `You are at ${result.used ?? "?"} of ${result.limit ?? "?"} live listings on your plan. ` +
            "Upgrade, or end some listings, to import more.",
          { duration: 12_000 },
        );
        return;
      }
      // Our own sentence for the extension's reason code, never the wire text
      // (US-2869 AC4). The extension carries the same sentences, but the web
      // must not print whatever arrived.
      toast.error(closetImportFailureText(res.reason ?? null, platform), {
        duration: 10_000,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shirt className="h-5 w-5" />
          Import my closet
        </CardTitle>
        <CardDescription>
          Bring the listings you already have on {platformNames} into FlipDesk
          without retyping them. Open your own closet in another tab, scroll so
          your listings are on screen, then press Import here. Without a
          FlipDesk plan the first {FREE_CLOSET_IMPORT_ROWS} listings of a read
          come in, up to what your plan has room for; a FlipDesk plan takes the
          rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {CLOSET_IMPORT_PLATFORMS.map((platform) => {
          const disclosure = closetImportDisclosureFor(platform);
          return (
            <div key={platform} className="rounded-md border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-medium">{disclosure.title}</div>
                <Button
                  size="sm"
                  disabled={disabled || busy !== null}
                  onClick={() => void run(platform)}
                >
                  {busy === platform ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Chrome className="mr-2 h-4 w-4" />
                  )}
                  Import from {MARKETPLACE_LABELS[platform]}
                </Button>
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {disclosure.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
