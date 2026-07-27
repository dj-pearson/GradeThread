import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BadgeCheck, Loader2, ShieldCheck } from "lucide-react";
import { SEO } from "@/components/seo";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { edgeApiUrl } from "@/lib/edge-api";

// US-1818: the PUBLIC, opt-in buyer Trust Score profile (/trust/:handle). Client-
// rendered and NOINDEX — it carries a chosen alias + opted-in stats only, but we
// keep it out of the index as a defense-in-depth privacy posture (it is not
// registered in public-routes.ts / the sitemap). The edge read hard-filters to
// enabled profiles and emits only opted-in fields.

interface PublicProfile {
  handle: string;
  displayName: string;
  level?: number;
  levelLabel?: string;
  confirmations?: number;
  memberSince?: string | null;
}

export function TrustProfilePage() {
  const { handle } = useParams<{ handle: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "not-found" | "error">("loading");

  useEffect(() => {
    let live = true;
    setState("loading");
    (async () => {
      try {
        const res = await fetch(
          `${edgeApiUrl()}/api/content/public/buyer-profile/${encodeURIComponent(handle!)}`,
        );
        if (!live) return;
        if (res.status === 404) return setState("not-found");
        if (!res.ok) return setState("error");
        const json = await res.json();
        setProfile(json.profile as PublicProfile);
        setState("ok");
      } catch {
        if (live) setState("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [handle]);

  if (state === "loading") {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (state !== "ok" || !profile) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <SEO title="Profile not found — GradeThread" description="This buyer profile isn't available." noindex />
        <EmptyState
          icon={ShieldCheck}
          title="Profile not available"
          description="This buyer hasn't made their Trust Score profile public, or the link is incorrect."
        />
        <div className="mt-6 text-center">
          <Button asChild variant="outline">
            <Link to="/">Back to GradeThread</Link>
          </Button>
        </div>
      </div>
    );
  }

  const memberSince = profile.memberSince ? new Date(profile.memberSince).getFullYear() : null;

  return (
    <main className="mx-auto max-w-lg py-10">
      <SEO
        title={`${profile.displayName} — GradeThread buyer`}
        description={`${profile.displayName}'s GradeThread buyer Trust Score profile.`}
        noindex
      />
      <div className="rounded-t-xl bg-brand-navy py-8 text-center text-white">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">
          <BadgeCheck className="h-4 w-4" /> GradeThread Buyer
        </span>
        <h1 className="mt-3 text-2xl font-bold">{profile.displayName}</h1>
        {profile.levelLabel && (
          <p className="mt-1 text-sm capitalize text-white/80">
            {profile.levelLabel} · Trust level {profile.level}
          </p>
        )}
      </div>

      <Card className="rounded-t-none">
        <CardContent className="grid grid-cols-2 gap-4 py-6 text-center">
          {profile.confirmations != null && (
            <div>
              <p className="text-2xl font-bold tabular-nums">{profile.confirmations}</p>
              <p className="text-xs text-muted-foreground">grades confirmed</p>
            </div>
          )}
          {memberSince != null && (
            <div>
              <p className="text-2xl font-bold tabular-nums">{memberSince}</p>
              <p className="text-xs text-muted-foreground">member since</p>
            </div>
          )}
          {profile.confirmations == null && memberSince == null && (
            <p className="col-span-2 text-sm text-muted-foreground">
              This buyer keeps their stats private.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Trust Scores reward honest post-sale grade confirmations on GradeThread.{" "}
        <Link to="/" className="underline">Learn more</Link>
      </p>
    </main>
  );
}
