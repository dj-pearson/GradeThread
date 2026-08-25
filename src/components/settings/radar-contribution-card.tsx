import { useState } from "react";
import { Link } from "react-router";
import { Radar } from "lucide-react";
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

// US-1861: the Thrift Radar contribution consent.
//
// A NEW toggle, deliberately not a widening of "Share sale outcomes" or the
// analytics switch. Both of those have copy that names what they send; location
// is a different kind of data, so folding it in would make a sentence somebody
// already read retroactively false. Same reason it gets its own storage column
// (users.radar_contribute) and its own section in the privacy policy.
//
// The copy below is the consent. It is written to be checkable against the code:
// every claim maps to something the server actually does — the coordinate is
// turned into a cell and dropped (lib/radar-privacy.ts), the account is replaced
// by a rotating salted digest, and the scan itself never waits on any of it.
export function RadarContributionCard() {
  const { user, profile, refreshProfile } = useAuth();
  const [enabled, setEnabled] = useState(profile?.radar_contribute ?? false);
  const [saving, setSaving] = useState(false);

  async function handleChange(next: boolean) {
    if (!user) return;
    setSaving(true);
    setEnabled(next);
    try {
      const { error } = await supabase
        .from("users")
        .update({ radar_contribute: next } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success(
        next
          ? "Thanks — your scans will help map where good stuff turns up."
          : "Radar contribution turned off. Nothing more will be shared."
      );
    } catch (err) {
      setEnabled(!next);
      toastError(err, "Failed to update Radar contribution.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radar className="h-5 w-5 text-primary" />
          Thrift Radar
        </CardTitle>
        <CardDescription>
          Turn your Prospect scans into a shared map of where secondhand supply
          shows up. Off unless you turn it on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Contribute to Thrift Radar</p>
            <p className="text-xs text-muted-foreground">
              While this is on, each Prospect scan you run adds one anonymous
              observation to the shared map.
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={handleChange}
            disabled={saving}
            aria-label="Contribute to Thrift Radar"
          />
        </div>

        <Separator />

        <div className="space-y-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What each scan shares</p>
          <ul className="space-y-1.5">
            <li>
              The rough area you scanned in, rounded to a cell about a
              kilometre across. Your exact position is used to work out that
              cell and is then thrown away. We never store it.
            </li>
            <li>
              The brand and category we read off the item, the condition band
              (roughly excellent, good, or fair) and whether it looked worth
              buying. Not your photos, not the price you paid.
            </li>
            <li>
              A scrambled code instead of your name or account, so scans can be
              counted without being traced to you. The code is regenerated every
              week, so contributions cannot be strung together over time.
            </li>
          </ul>
          <p className="font-medium text-foreground">Your own store history</p>
          <p>
            Separate from this, and always yours: we keep a private record of
            which stores you scanned at so &ldquo;My stores&rdquo; can show you
            what each one has earned you. It is never part of the shared map, it
            is not shared with anyone, and you can see it under Sourcing &rarr;
            My stores.
          </p>
          <p>
            Looking at Radar is a separate choice. Turning this off does not
            take the map away, and turning the map on never signs you up to
            contribute. Sharing stops the moment you turn this off — see our{" "}
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
