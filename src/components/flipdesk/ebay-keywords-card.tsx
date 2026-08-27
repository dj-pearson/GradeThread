import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2, Plus, Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2945: keywords for Promoted Listings Advanced.
//
// FlipDesk could create a CPC campaign and an ad group and then had no way to
// put a keyword in either. A bid you cannot aim is a bid you cannot control,
// and that aim is the only difference between Advanced and Standard.
//
// ── THE NEGATIVE KEYWORDS COME FIRST ON PURPOSE ─────────────────────────────
//
// Adding keywords spends money. Adding negative keywords stops spending it, and
// it is the half a seller can act on today — the evidence is already in their
// own reported search terms. Each candidate names its clicks, so the seller is
// blocking a number rather than a hunch.

interface Keyword {
  keywordId: string;
  text: string;
  matchType: string | null;
  status: string | null;
  bidCents: number | null;
}

interface NegativeKeyword {
  negativeKeywordId: string;
  text: string;
  matchType: string | null;
}

interface NegativeCandidate {
  term: string;
  clicks: number;
  impressions: number;
  reason: string;
}

interface KeywordsResponse {
  campaignId: string;
  adGroupId: string;
  keywords: Keyword[];
  negatives: NegativeKeyword[];
  negativeCandidates: NegativeCandidate[];
}

export function EbayKeywordsCard() {
  const qc = useQueryClient();
  const [newKeyword, setNewKeyword] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["ebay_keywords"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<KeywordsResponse> => {
      const res = await edgeFetch("/api/flipdesk/ebay/marketing/keywords");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load your eBay keywords.");
      return json as KeywordsResponse;
    },
  });

  const { data: suggestions } = useQuery({
    queryKey: ["ebay_keyword_suggestions"],
    enabled: showSuggestions,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<{ suggestions: string[] }> => {
      const res = await edgeFetch("/api/flipdesk/ebay/marketing/keywords/suggestions");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load suggestions.");
      return json as { suggestions: string[] };
    },
  });

  const addKeyword = useMutation<unknown, Error, { text: string }>({
    mutationFn: async ({ text }) => {
      const res = await edgeFetch("/api/flipdesk/ebay/marketing/keywords", {
        method: "POST",
        body: JSON.stringify({ text, match_type: "PHRASE" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "eBay rejected the keyword.");
      return json;
    },
    onSuccess: () => {
      toast.success("Keyword added.");
      setNewKeyword("");
      void qc.invalidateQueries({ queryKey: ["ebay_keywords"] });
    },
    onError: (err) => toastError(err, "eBay rejected the keyword."),
  });

  const block = useMutation<unknown, Error, { text: string }>({
    mutationFn: async ({ text }) => {
      const res = await edgeFetch("/api/flipdesk/ebay/marketing/negative-keywords", {
        method: "POST",
        body: JSON.stringify({ text, match_type: "PHRASE" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "eBay rejected the negative keyword.");
      return json;
    },
    onSuccess: () => {
      toast.success("Blocked. eBay stops bidding on that search.");
      void qc.invalidateQueries({ queryKey: ["ebay_keywords"] });
    },
    onError: (err) => toastError(err, "eBay rejected the negative keyword."),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ad keywords</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ad keywords</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No cost-per-click campaign to read yet. Keywords apply to Promoted
            Listings Advanced only.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="h-4 w-4" />
          Ad keywords
        </CardTitle>
        <CardDescription>
          What your cost-per-click ads bid on, and what they should stop bidding on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Money saved before money spent. */}
        {data.negativeCandidates.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Searches costing you clicks and no sales</h3>
            <ul className="space-y-1">
              {data.negativeCandidates.slice(0, 10).map((cand) => (
                <li
                  key={cand.term}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{cand.term}</span>
                  <span className="text-xs text-muted-foreground">{cand.reason}</span>
                  <Button
                    aria-label={`Stop bidding on ${cand.term}`}
                    size="sm"
                    variant="outline"
                    disabled={block.isPending}
                    onClick={() => block.mutate({ text: cand.term })}
                  >
                    <Ban className="mr-1 h-3.5 w-3.5" />
                    Block
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Keywords ({data.keywords.length})</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="new-keyword" className="sr-only">
              New keyword
            </Label>
            <Input
              id="new-keyword"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              placeholder="carhartt detroit jacket"
              className="h-8 max-w-xs"
            />
            <Button
              size="sm"
              disabled={!newKeyword.trim() || addKeyword.isPending}
              onClick={() => addKeyword.mutate({ text: newKeyword.trim() })}
            >
              {addKeyword.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1 h-3.5 w-3.5" />
              )}
              Add
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowSuggestions((v) => !v)}
            >
              {showSuggestions ? "Hide eBay's ideas" : "See eBay's ideas"}
            </Button>
          </div>

          {/* Proposals, never auto-added. */}
          {showSuggestions && (
            <div className="flex flex-wrap gap-1">
              {(suggestions?.suggestions ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  eBay has no suggestions for this campaign right now.
                </p>
              ) : (
                suggestions!.suggestions.map((sug) => (
                  <Button
                    key={sug}
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs font-normal"
                    onClick={() => setNewKeyword(sug)}
                  >
                    {sug}
                  </Button>
                ))
              )}
            </div>
          )}

          {data.keywords.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No keywords yet, so eBay matches your ads to whatever it decides.
            </p>
          ) : (
            <ul className="space-y-1">
              {data.keywords.map((k) => (
                <li
                  key={k.keywordId}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{k.text}</span>
                  {k.matchType && (
                    <Badge variant="outline" className="text-[10px]">
                      {k.matchType.toLowerCase()}
                    </Badge>
                  )}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {k.bidCents == null
                      ? "uses the group bid"
                      : `$${(k.bidCents / 100).toFixed(2)}`}
                  </span>
                  {k.status && k.status !== "ACTIVE" && (
                    <Badge variant="secondary" className="text-[10px]">
                      {k.status.toLowerCase()}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {data.negatives.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Blocked searches ({data.negatives.length})</h3>
            <div className="flex flex-wrap gap-1">
              {data.negatives.map((n) => (
                <Badge key={n.negativeKeywordId} variant="secondary" className="text-[10px]">
                  {n.text}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
