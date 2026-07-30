import { Loader2, Sparkles, Wand2 } from "lucide-react";
import { AiDiffChip } from "@/components/flipdesk/ai-diff-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { textChanged } from "@/lib/listing-ai-diff";
import type { ListingAiSnapshot } from "@/types/database";
import type { RewriteAction } from "@/hooks/use-ai-extract";
export interface DescriptionCardProps {
  description: string;
  setDescription: (next: string) => void;
  /** Which template group the item maps to. */
  group: string;
  applyTemplate: () => void;
  /** Regenerate-from-photos needs at least one photo. */
  photoCount: number;
  aiRewrite: { isPending: boolean };
  rewriteAction: string | null;
  runRewrite: (action: RewriteAction) => void;
  aiSnapshot: ListingAiSnapshot | null;
  isEbayOrigin: boolean;
  ebayOwnedHint: string | undefined;
}
// The buyer-facing description. Template-then-edit, with the US-552 inline AI
// rewrite reviewed through AiFillPanel — nothing is applied silently.
export function DescriptionCard({
  description,
  setDescription,
  group,
  applyTemplate,
  photoCount,
  aiRewrite,
  rewriteAction,
  runRewrite,
  aiSnapshot,
  isEbayOrigin,
  ebayOwnedHint,
}: DescriptionCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Description</CardTitle>
            <CardDescription>
              Apply the{" "}
              <Badge variant="outline" className="capitalize">
                {group}
              </Badge>{" "}
              template, then edit freely.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isEbayOrigin}
              title={ebayOwnedHint}
              onClick={applyTemplate}
            >
              <Wand2 className="mr-2 h-3 w-3" />
              Apply template
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aiRewrite.isPending || isEbayOrigin}
                  title={ebayOwnedHint}
                >
                  {aiRewrite.isPending &&
                  rewriteAction?.startsWith("description_") ? (
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 h-3 w-3" />
                  )}
                  AI rewrite
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!description.trim()}
                  onClick={() => void runRewrite("description_tighten")}
                >
                  Tighten &amp; polish
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={photoCount === 0}
                  onClick={() => void runRewrite("description_regen")}
                >
                  Regenerate from photos
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={14}
          placeholder="Apply the template above, or write your own."
          className="font-mono text-xs"
          disabled={isEbayOrigin}
          title={
            isEbayOrigin
              ? "eBay owns this listing's description — edit it on eBay."
              : undefined
          }
        />
        {aiSnapshot?.description && (
          <AiDiffChip
            changed={textChanged(aiSnapshot.description, description)}
            aiDisplay="AI draft"
            onRevert={() => setDescription(aiSnapshot.description ?? "")}
          />
        )}
      </CardContent>
    </Card>
  );
}