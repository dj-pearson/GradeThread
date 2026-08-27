import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail, Send } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2953: the audience the seller already owns.
//
// An eBay Store's followers cost nothing to reach and convert better than any
// paid impression, because they chose to follow this shop. FlipDesk could not
// send to them at all.
//
// ── EVERY SEND IS A HUMAN ACTION, CONFIRMED, WITH THE COUNT ─────────────────
//
// No automation reaches this. A mailing list is the one asset here that a
// mistake destroys permanently: a rule that emails followers weekly because a
// threshold drifted does not produce a bad campaign, it produces unfollows, and
// those do not come back. So the send is a button, behind a confirm that names
// how many people it reaches.

interface Campaign {
  campaignId: string;
  name: string | null;
  status: string | null;
  scheduledAt: string | null;
  recipientCount: number | null;
  opens: number | null;
  clicks: number | null;
}

interface CampaignsResponse {
  available: boolean;
  detail?: string;
  campaigns: Campaign[];
}

export function FollowerCampaignCard() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [sending, setSending] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["ebay_email_campaigns"],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<CampaignsResponse> => {
      const res = await edgeFetch("/api/flipdesk/ebay/marketing/email-campaigns");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load your eBay campaigns.");
      return json as CampaignsResponse;
    },
  });

  const send = useMutation<unknown, Error, { campaignId: string }>({
    mutationFn: async ({ campaignId }) => {
      const res = await edgeFetch(
        `/api/flipdesk/ebay/marketing/email-campaigns/${encodeURIComponent(campaignId)}/send`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "eBay rejected the send.");
      return json;
    },
    onSuccess: () => {
      toast.success("Sent to your followers.");
      void qc.invalidateQueries({ queryKey: ["ebay_email_campaigns"] });
    },
    onError: (err) => toastError(err, "eBay rejected the send."),
    onSettled: () => setSending(null),
  });

  async function confirmSend(c: Campaign) {
    const ok = await confirm({
      title: c.recipientCount
        ? `Email ${c.recipientCount} follower${c.recipientCount === 1 ? "" : "s"}?`
        : "Email your followers?",
      description:
        "This goes out immediately and cannot be recalled. People who unfollow after a campaign do not come back.",
      confirmLabel: "Send it",
    });
    if (!ok) return;
    setSending(c.campaignId);
    send.mutate({ campaignId: c.campaignId });
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email your followers</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4" />
          Email your followers
        </CardTitle>
        <CardDescription>
          People who follow your eBay shop. Costs nothing to reach.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data.available ? (
          // Read off eBay's answer, not guessed from the account — so a seller
          // who subscribes tomorrow sees this disappear on its own.
          <p className="text-sm text-muted-foreground">{data.detail}</p>
        ) : data.campaigns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No campaigns yet. Build one from a saved filter on the Listings page —
            newly listed this week, or anything aged over 60 days.
          </p>
        ) : (
          <ul className="space-y-1">
            {data.campaigns.map((c) => (
              <li
                key={c.campaignId}
                className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{c.name || c.campaignId}</span>
                {c.status && (
                  <Badge variant="outline" className="text-[10px]">
                    {c.status.toLowerCase()}
                  </Badge>
                )}
                <span className="text-xs tabular-nums text-muted-foreground">
                  {/* Null is "not sent yet", never 0 — a zero would read as a
                      campaign that reached nobody. */}
                  {c.recipientCount == null
                    ? "not sent yet"
                    : `${c.recipientCount} sent${
                      c.opens != null ? ` · ${c.opens} opened` : ""
                    }${c.clicks != null ? ` · ${c.clicks} clicked` : ""}`}
                </span>
                {(c.status ?? "").toUpperCase().includes("DRAFT") && (
                  <Button
                    aria-label={`Send the campaign ${c.name || c.campaignId} to your followers`}
                    size="sm"
                    disabled={send.isPending}
                    onClick={() => confirmSend(c)}
                  >
                    {sending === c.campaignId ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="mr-1 h-3.5 w-3.5" />
                    )}
                    Send
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
