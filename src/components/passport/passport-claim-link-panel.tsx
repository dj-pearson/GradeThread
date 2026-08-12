import { useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CopyField } from "@/components/verified/copy-field";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2494: the second owner handoff, next to the reusable QR tag. This one is
// for a garment that ships: a single-use link the buyer opens to take over the
// passport. The edge returns the raw token exactly once (only its hash is
// stored), so it lives in this component's state and nowhere else: not in a
// log line, not in the URL bar, not in storage.

interface PassportClaimLinkPanelProps {
  /** The garment whose passport the buyer would claim. */
  garmentId: string;
}

export function PassportClaimLinkPanel({ garmentId }: PassportClaimLinkPanelProps) {
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  async function mint() {
    setMinting(true);
    try {
      const res = await edgeFetch(
        `/api/passport/garments/${garmentId}/claim-token`,
        { method: "POST", json: {} },
      );
      if (!res.ok) throw new Error(`mint failed: ${res.status}`);
      // Deliberately reads claim_url only. The bare `token` in the body is the
      // same secret in a less useful form, so there's no reason to hold it.
      const data = (await res.json()) as {
        claim_url: string;
        expires_at: string;
      };
      setClaimUrl(data.claim_url);
      setExpiresAt(data.expires_at);
      toast.success("Claim link created");
    } catch {
      toast.error("Couldn't create a claim link. Please try again.");
    } finally {
      setMinting(false);
    }
  }

  const expiryLabel = expiresAt
    ? new Date(expiresAt).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" />
          Claim link for a shipped sale
        </CardTitle>
        <CardDescription>
          Send this to one buyer after the garment ships. It works once, then
          stops. It also expires 30 days after you create it. For a garment you
          hand over in person, print the tag above instead: that tag keeps
          working for whoever holds it until you revoke it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!claimUrl ? (
          <Button onClick={mint} disabled={minting}>
            {minting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating link...
              </>
            ) : (
              <>
                <Link2 className="mr-2 h-4 w-4" /> Create claim link
              </>
            )}
          </Button>
        ) : (
          <>
            <CopyField label="Claim link" value={claimUrl} multiline />
            <p className="text-sm text-muted-foreground">
              Copy it now. We only keep a scrambled copy, so this link can't be
              shown again. {expiryLabel ? `It expires on ${expiryLabel}.` : null}
            </p>
            {/* Minting again ADDS a token; the edge revokes nothing, so the
                button and the note below both avoid the word "replace". */}
            <Button variant="ghost" size="sm" onClick={mint} disabled={minting}>
              Create another link
            </Button>
            <p className="text-xs text-muted-foreground">
              A second link doesn't cancel this one. Each link works once, on its
              own, so only make another if this one is lost.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
