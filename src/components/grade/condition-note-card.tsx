import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MARKETPLACE_SPECS, type MarketplacePlatform } from "@/lib/marketplace-specs";
import {
  buildConditionNote,
  conditionNoteLimit,
  type ConditionNoteReport,
} from "@/lib/condition-note";

// SUB-15: "Condition text for your listing". Pick the marketplace, copy the
// text, paste it into the listing. The certificate link inside it is what lets
// a buyer check the grade for themselves.

const PLATFORMS = Object.keys(MARKETPLACE_SPECS) as MarketplacePlatform[];

export function ConditionNoteCard({
  report,
  certificateId,
}: {
  report: ConditionNoteReport;
  certificateId: string;
}) {
  const [platform, setPlatform] = useState<MarketplacePlatform>("ebay");
  const note = useMemo(
    () =>
      buildConditionNote(
        report,
        platform,
        `${window.location.origin}/cert/${certificateId}`,
      ),
    [report, platform, certificateId],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(note);
      toast.success("Condition text copied.");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it yourself.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Condition text for your listing</CardTitle>
        <CardDescription>
          The grade, the main flaws and a link buyers can use to check it, sized
          for the marketplace you pick.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48 space-y-1.5">
            <Label htmlFor="condition-note-platform">Marketplace</Label>
            <Select
              value={platform}
              onValueChange={(v) => setPlatform(v as MarketplacePlatform)}
            >
              <SelectTrigger id="condition-note-platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {MARKETPLACE_SPECS[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" onClick={() => void copy()}>
            <Copy className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Copy
          </Button>
        </div>
        <Textarea
          readOnly
          aria-label="Condition text"
          value={note}
          rows={7}
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {note.length} of {conditionNoteLimit(platform)} characters
        </p>
      </CardContent>
    </Card>
  );
}
