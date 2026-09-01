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
  type ClosetImportPlatform,
} from "@/lib/marketplace-disclosure";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { sendClosetImport } from "@/lib/lister-extension";
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
// SHOWN ONLY when the extension is installed AND the account is on an active
// paid FlipDesk plan, the same gate the Lister uses (extension-unified/
// registry.js resolves it; useExtensionSetup reads it back). A seller who
// cannot use it does not see a button that would refuse them.

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

  if (!setup?.installed || !setup.sellerEnabled) return null;

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
      toast.error(
        res.error || result?.message || result?.error || "Could not read your closet.",
        { duration: 10_000 },
      );
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
          Bring the listings you already have on Poshmark or Mercari into
          FlipDesk without retyping them. Open your own closet in another tab,
          scroll so your listings are on screen, then press Import here.
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
