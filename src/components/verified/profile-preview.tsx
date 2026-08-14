import { BadgeCheck, EyeOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SITE_URL } from "@/lib/seo/site";

// US-2543 AC4. Configuring the public profile used to be blind: the only way to
// see the result was opening the live URL in another tab, which does not exist
// until you have saved AND published. So the first draft of a handle, a display
// name and a bio was always written without seeing any of it.
//
// This mirrors the hero of src/pages/verified-seller.tsx (navy band, verified
// pill, name, bio, the two stats) against the UNSAVED form values, so what you
// type is what you see. It is deliberately not a full copy of that page: level
// flair, integrity tier and the storefront grid are server-computed, and
// inventing them here would be showing the seller something that is not real.

export function VerifiedProfilePreview({
  handle,
  displayName,
  bio,
  isLive,
  totalGraded,
  averageGrade,
  showListings,
}: {
  handle: string;
  displayName: string;
  bio: string;
  isLive: boolean;
  totalGraded: number;
  averageGrade: number;
  showListings: boolean;
}) {
  const name = displayName.trim() || "Your store name";
  const path = `${SITE_URL.replace("https://", "")}/verified/${handle || "your-handle"}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Preview</CardTitle>
          {isLive ? (
            <Badge variant="secondary">Live at {path}</Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <EyeOff className="h-3 w-3" />
              Not published yet
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border">
          <div className="bg-brand-navy px-6 py-6 text-white">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">
                <BadgeCheck className="h-3.5 w-3.5" />
                GradeThread Verified Seller
              </span>
              <p className="text-xl font-bold">{name}</p>
              {bio.trim() && (
                <p className="max-w-md text-sm text-white/80">{bio.trim()}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x border-t">
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-extrabold text-brand-navy dark:text-foreground">
                {totalGraded}
              </p>
              <p className="text-xs text-muted-foreground">verified grades</p>
            </div>
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-extrabold text-brand-navy dark:text-foreground">
                {averageGrade > 0 ? averageGrade.toFixed(1) : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                average grade · out of 10
              </p>
            </div>
          </div>
          {showListings && (
            <p className="border-t px-4 py-2 text-center text-xs text-muted-foreground">
              Your active listings appear below this, newest first.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
