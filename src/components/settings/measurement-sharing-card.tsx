import { useState } from "react";
import { Link } from "react-router";
import { Ruler } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";

// US-3038: consent for the Fit & Measurement Index.
//
// ITS OWN TOGGLE AND ITS OWN COLUMN, for the reason radar-contribution-card.tsx
// gives about itself: folding a new kind of sharing into an existing switch
// makes a sentence somebody already read retroactively false. "Share sale
// outcomes" names a sold price; this names garment measurements. Different
// data, different consent.
//
// THIS ONE IS OPT-OUT, WHICH THE OTHERS ARE NOT, and that is exactly why the
// copy has to be this explicit and why it is a card rather than a line. An
// opt-in switch that nobody finds costs the user nothing. An opt-out switch
// nobody finds is a promise that was never really made.
//
// The copy is written to be checkable against the code. Every claim maps to
// something that actually happens:
//   - "five garments from at least three different sellers" is
//     MIN_MEASUREMENT_SAMPLE / MIN_MEASUREMENT_CONTRIBUTORS in
//     measurement-aggregate.ts, enforced before `sufficient` is ever true.
//   - "deletes the measurements you have already contributed" is the 00710
//     trigger, which runs in the database rather than in this component.
//   - "recalculated, not frozen" is the retirement pass in
//     computeMeasurementAggregates, which unpublishes a cohort that falls under
//     the floor on its next run.
// If any of those change, this copy is wrong and has to change with them.
export function MeasurementSharingCard() {
  const { user, profile, refreshProfile } = useAuth();
  const [enabled, setEnabled] = useState(
    profile?.share_garment_measurements ?? true,
  );
  const [saving, setSaving] = useState(false);

  async function handleChange(next: boolean) {
    if (!user) return;
    setSaving(true);
    setEnabled(next);
    try {
      const { error } = await supabase
        .from("users")
        .update({ share_garment_measurements: next } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success(
        next
          ? "Thanks — your measurements will help build the size guides."
          : "Turned off. The measurements you had contributed have been deleted.",
      );
    } catch (err) {
      setEnabled(!next);
      toastError(err, "Failed to update measurement sharing.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ruler className="h-5 w-5 text-primary" />
          Measurement sharing
        </CardTitle>
        <CardDescription>
          Brands publish body size charts. Almost nobody publishes what a
          garment actually measures laid flat. Your measurements help fill that
          in. On unless you turn it off.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              Contribute measurements to the size guides
            </p>
            <p className="text-xs text-muted-foreground">
              While this is on, the measurements you record for an item are
              added to a shared average for that brand, style and size.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleChange}
            disabled={saving}
            aria-label="Contribute measurements to the size guides"
          />
        </div>

        <Separator />

        <div className="space-y-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What is shared</p>
          <ul className="space-y-1.5">
            <li>
              The measurements themselves, and the brand, style and size they
              belong to. Not your photos, not your prices, not your listings.
            </li>
            <li>
              Nothing is published until at least five garments from at least
              three different sellers back it. A number that only your items
              support is never shown to anyone.
            </li>
            <li>
              What gets published is the middle value across all those garments.
              Nobody can tell which measurement was yours, and your name and
              account are not attached to any of it.
            </li>
          </ul>
          <p className="font-medium text-foreground">If you turn this off</p>
          <p>
            We stop taking new measurements and delete the ones you have already
            contributed. Averages that included them are recalculated on the
            next daily update rather than frozen, so a page can still show the
            old number for up to a day before it catches up. If that leaves
            fewer than five garments behind it, the number stops being shown at
            all.
          </p>
          <p>
            Deleting your account removes your measurements the same way. See
            our{" "}
            <Link to="/privacy" className="underline hover:text-foreground">
              Privacy Policy
            </Link>{" "}
            for the full detail.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
