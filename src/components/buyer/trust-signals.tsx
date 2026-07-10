import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { edgeFetch } from "@/lib/edge-fetch";
import { cn } from "@/lib/utils";
import type { CertTrustSignals } from "@/hooks/use-buyer-trust-signals";

// US-1844: render a graded item's coarse public trust signals for a buyer,
// deep-linking to the full certificate. The badges come straight from the
// server projection (use-buyer-trust-signals) — the buyer sees exactly the cues
// the public cert page shows. Clicking attributes to US-1760 (source=buyer).

/** Fire-and-forget attribution ping — never blocks or fails the navigation. */
function pingBadgeClick(certId: string) {
  edgeFetch("/api/content/public/badge-click", {
    method: "POST",
    skipWorkspaceHeader: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetType: "cert", targetId: certId, source: "buyer" }),
  }).catch(() => {
    /* attribution is best-effort */
  });
}

interface TrustSignalBadgesProps {
  certId: string;
  signals: CertTrustSignals | undefined;
  className?: string;
  /** Cap the number of pills shown inline (rest summarized as "+N"). */
  max?: number;
}

export function TrustSignalBadges({ certId, signals, className, max = 3 }: TrustSignalBadgesProps) {
  if (!signals || !signals.hasAny) return null;
  const shown = signals.badges.slice(0, max);
  const extra = signals.badges.length - shown.length;
  return (
    <Link
      to={signals.certUrl}
      onClick={() => pingBadgeClick(certId)}
      className={cn(
        "inline-flex flex-wrap items-center gap-1 rounded-md hover:opacity-80",
        className,
      )}
      title="View the verified certificate"
    >
      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
      {shown.map((b) => (
        <Badge key={b.key} variant="secondary" className="text-[10px] font-medium">
          {b.label}
        </Badge>
      ))}
      {extra > 0 && (
        <Badge variant="secondary" className="text-[10px] font-medium">
          +{extra}
        </Badge>
      )}
    </Link>
  );
}
