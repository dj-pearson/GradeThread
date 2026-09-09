import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toastError } from "@/lib/toast-error";
import {
  LISTING_VOICE_MAX_LEN,
  useListingVoice,
  useSetListingVoice,
} from "@/hooks/use-listing-voice";

// US-3201: how the seller wants their listing copy to sound.
//
// The standing LINES are already theirs — that is what snippets are, and this
// sits above them on the same page. What was never theirs is the VOICE: the
// generator carried a hardcoded per-marketplace tone and nothing per seller, so
// every GradeThread closet read the same.
//
// SCOPE, STATED ON SCREEN. This changes register, not facts. The measurements,
// the grade and the item specifics come from the item and are not up for
// rewriting by an instruction typed here, and the seller is better served
// knowing that than discovering it.
//
// Empty means off, and off is byte-identical to before this existed.

const PLACEHOLDER =
  "Write like you are texting a friend who knows clothes. Short sentences. " +
  "Lead with the fit. No exclamation marks, and never call anything a steal.";

export function ListingVoiceSetting() {
  const { data: stored, isLoading } = useListingVoice();
  const save = useSetListingVoice();
  const [draft, setDraft] = useState("");

  // Seed from the stored value once it arrives, and re-seed if it changes
  // under us (another tab, another device).
  useEffect(() => {
    setDraft(stored ?? "");
  }, [stored]);

  const trimmed = draft.trim();
  const dirty = trimmed !== (stored ?? "");
  const over = trimmed.length - LISTING_VOICE_MAX_LEN;

  async function submit() {
    try {
      const value = await save.mutateAsync(draft);
      toast.success(
        value
          ? "Saved. New descriptions will use it."
          : "Cleared. Descriptions go back to the standard voice.",
      );
    } catch (err) {
      toastError(err, "That was not saved.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your listing voice</CardTitle>
        <CardDescription>
          Tell the description writer how you want to sound. It changes the
          wording only: measurements, the grade and item specifics still come
          from the item itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="listing-voice" className="sr-only">
          Your listing voice
        </Label>
        <Textarea
          id="listing-voice"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={4}
          disabled={isLoading}
          aria-describedby="listing-voice-count"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            id="listing-voice-count"
            className={
              over > 0
                ? "text-xs text-destructive tabular-nums"
                : "text-xs text-muted-foreground tabular-nums"
            }
          >
            {over > 0
              ? `${over.toLocaleString()} characters too many`
              : trimmed === ""
                ? "Empty means the standard voice."
                : `${trimmed.length.toLocaleString()} / ${LISTING_VOICE_MAX_LEN.toLocaleString()}`}
          </p>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!dirty || over > 0 || save.isPending || isLoading}
          >
            {save.isPending ? "Saving…" : "Save voice"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
