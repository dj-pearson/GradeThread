import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  ExternalLink,
  Loader2,
  Check,
  X,
  ShieldCheck,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyField } from "@/components/verified/copy-field";
import {
  useVerifiedProfile,
  useUpdateVerifiedProfile,
  checkHandleAvailable,
} from "@/hooks/use-verified";
import {
  validateHandle,
  profileUrl,
  profileLinkEmbedHtml,
} from "@/lib/verified";
import { SITE_URL } from "@/lib/seo/public-routes";

type Availability =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" }
  | { state: "error"; reason: string };

export function FlipdeskVerifiedPage() {
  const { data, isLoading } = useVerifiedProfile();
  const update = useUpdateVerifiedProfile();

  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [showListings, setShowListings] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  const seeded = useRef(false);

  // Seed the form once the profile loads.
  useEffect(() => {
    if (!data || seeded.current) return;
    setHandle(data.profile.handle ?? "");
    setDisplayName(data.profile.display_name ?? "");
    setBio(data.profile.bio ?? "");
    setEnabled(data.profile.enabled);
    setShowListings(data.profile.show_listings);
    seeded.current = true;
  }, [data]);

  const savedHandle = data?.profile.handle ?? null;
  const normalizedHandle = handle.trim().toLowerCase();
  const handleFormat = useMemo(
    () => (normalizedHandle ? validateHandle(normalizedHandle) : null),
    [normalizedHandle],
  );

  // Debounced availability check while typing a NEW handle.
  useEffect(() => {
    if (!normalizedHandle || normalizedHandle === savedHandle) {
      setAvailability({ state: "idle" });
      return;
    }
    if (handleFormat && !handleFormat.ok) {
      setAvailability({ state: "error", reason: handleFormat.reason });
      return;
    }
    setAvailability({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const res = await checkHandleAvailable(normalizedHandle);
        setAvailability(
          res.available
            ? { state: "ok" }
            : { state: "error", reason: res.reason ?? "Handle unavailable." },
        );
      } catch {
        setAvailability({ state: "idle" });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [normalizedHandle, savedHandle, handleFormat]);

  const canSave =
    !!normalizedHandle &&
    (handleFormat?.ok ?? false) &&
    availability.state !== "checking" &&
    availability.state !== "error";

  async function handleSave() {
    await update.mutateAsync({
      handle: normalizedHandle,
      display_name: displayName.trim() || null,
      bio: bio.trim() || null,
    });
  }

  async function handleToggle(next: boolean) {
    // Reflect immediately; revert on failure.
    setEnabled(next);
    try {
      await update.mutateAsync({
        handle: normalizedHandle || undefined,
        enabled: next,
      });
    } catch {
      setEnabled(!next);
    }
  }

  async function handleShowListingsToggle(next: boolean) {
    setShowListings(next);
    try {
      await update.mutateAsync({ show_listings: next });
    } catch {
      setShowListings(!next);
    }
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const isLive = enabled && !!savedHandle;
  const liveUrl = savedHandle ? profileUrl(savedHandle) : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-brand-navy dark:text-foreground" />
          <h1 className="text-2xl font-bold">GradeThread Verified</h1>
        </div>
        <p className="text-muted-foreground">
          Turn every grade you've earned into a public trust profile buyers can
          verify — and a badge you embed in your listings. The grade buyers can't
          fake becomes the reason they buy from you.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-extrabold text-brand-navy dark:text-foreground">
              {data?.stats.total_graded ?? 0}
            </div>
            <p className="text-sm text-muted-foreground">verified grades</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-extrabold text-brand-navy dark:text-foreground">
              {data && data.stats.average_grade > 0
                ? data.stats.average_grade.toFixed(1)
                : "—"}
            </div>
            <p className="text-sm text-muted-foreground">average grade · out of 10</p>
          </CardContent>
        </Card>
      </div>

      {/* Profile form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your public profile</CardTitle>
          <CardDescription>
            Claim a handle at {SITE_URL.replace("https://", "")}/verified/…
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Handle */}
          <div className="space-y-1.5">
            <Label htmlFor="handle">Handle</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">/verified/</span>
              <div className="relative flex-1">
                <Input
                  id="handle"
                  value={handle}
                  placeholder="your-store-name"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) =>
                    setHandle(e.target.value.toLowerCase().replace(/\s+/g, "-"))
                  }
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                  {availability.state === "checking" && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                  {availability.state === "ok" && (
                    <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                  )}
                  {availability.state === "error" && (
                    <X className="h-4 w-4 text-red-600 dark:text-red-400" />
                  )}
                </div>
              </div>
            </div>
            {availability.state === "error" && (
              <p className="text-xs text-red-600 dark:text-red-400">{availability.reason}</p>
            )}
            {availability.state === "ok" && (
              <p className="text-xs text-green-600 dark:text-green-400">Available!</p>
            )}
          </div>

          {/* Display name */}
          <div className="space-y-1.5">
            <Label htmlFor="display_name">Display name</Label>
            <Input
              id="display_name"
              value={displayName}
              maxLength={60}
              placeholder="The name buyers see on your profile"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {/* Bio */}
          <div className="space-y-1.5">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              value={bio}
              maxLength={280}
              rows={3}
              placeholder="What you sell, your story — keep it short (280 chars)."
              onChange={(e) => setBio(e.target.value)}
            />
            <p className="text-right text-xs text-muted-foreground">
              {bio.length}/280
            </p>
          </div>

          <Button onClick={handleSave} disabled={!canSave || update.isPending}>
            {update.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save profile
          </Button>
        </CardContent>
      </Card>

      {/* Publish toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Make it public</CardTitle>
          <CardDescription>
            When public, anyone with the link can view your verified grades.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">Public profile</p>
              <p className="text-sm text-muted-foreground">
                {savedHandle
                  ? "Your profile is reachable at your handle URL."
                  : "Save a handle first to enable this."}
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={!savedHandle || update.isPending}
              onCheckedChange={handleToggle}
              aria-label="Toggle public profile"
            />
          </div>

          {/* Storefront opt-in — turns the profile into a shop. Only meaningful
              once the profile is public. */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">Show my listings (storefront)</p>
              <p className="text-sm text-muted-foreground">
                List your active items on your profile — graded items show their
                grade and link to the certificate, the rest link to their
                marketplace listing.
              </p>
            </div>
            <Switch
              checked={showListings}
              disabled={!isLive || update.isPending}
              onCheckedChange={handleShowListingsToggle}
              aria-label="Toggle storefront listings"
            />
          </div>

          {isLive && liveUrl && (
            <div className="space-y-3">
              <CopyField label="Your public profile link" value={liveUrl} />
              <a
                href={liveUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-navy hover:underline dark:text-foreground"
              >
                <ExternalLink className="h-4 w-4" />
                View public profile
              </a>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Embed: profile badge */}
      {isLive && savedHandle && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BadgeCheck className="h-5 w-5 text-brand-navy dark:text-foreground" />
              Embed your "Verified Seller" badge
            </CardTitle>
            <CardDescription>
              Paste this into your eBay, Poshmark, Mercari, Depop or Grailed
              listing description, your store bio, or your link-in-bio. It links
              buyers to your verified profile.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CopyField
              label="HTML (listing descriptions, websites)"
              value={profileLinkEmbedHtml(savedHandle)}
              multiline
            />
            <p className="text-sm text-muted-foreground">
              For a <strong>per-item</strong> grade badge, open any of your grade
              certificates and copy the badge embed from there — buyers see the
              exact condition grade for that listing.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
