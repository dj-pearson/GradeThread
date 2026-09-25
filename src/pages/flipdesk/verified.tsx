import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  BadgeCheck,
  ExternalLink,
  Loader2,
  Check,
  X,
  ShieldCheck,
  Eye,
  History,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyField } from "@/components/verified/copy-field";
import { VerifiedProfilePreview } from "@/components/verified/profile-preview";
import { BadgeStudio } from "@/components/verified/badge-studio";
import { ReadinessStrip } from "@/components/verified/readiness-strip";
import { readinessSteps, type ReadinessStepId } from "@/lib/verified-readiness";
import {
  useVerifiedProfile,
  useUpdateVerifiedProfile,
  useBadgeFunnel,
  checkHandleAvailable,
  type VerifiedProfile,
} from "@/hooks/use-verified";
import {
  usePassportIdentityNodes,
  useSetPassportReveal,
  type PassportIdentityNode,
} from "@/hooks/use-passport-identity";
import {
  validateHandle,
  profileUrl,
  profileLinkEmbedHtml,
  profileQrFilename,
  profileShareUrl,
  verifiedSellerBadgeEmbedText,
} from "@/lib/verified";
import { QRCodeCanvas } from "qrcode.react";
import { SITE_URL } from "@/lib/seo/site";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import { UnsavedChangesDialog } from "@/components/unsaved-changes-dialog";
import { PageHelp } from "@/components/help/page-help";

// US-2543: the most-used tab first.
const DEFAULT_TAB = "profile";

interface FormBaseline {
  handle: string;
  displayName: string;
  bio: string;
}

type Availability =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" }
  | { state: "error"; reason: string };

export function FlipdeskVerifiedPage() {
  const { data, isLoading, refetch, isFetching } = useVerifiedProfile();
  const update = useUpdateVerifiedProfile();
  const funnel = useBadgeFunnel();

  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [showListings, setShowListings] = useState(false);
  const [embedInListings, setEmbedInListings] = useState(false);
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  // What the text fields were last loaded or saved as. The form is dirty when
  // it differs from this, and Save is offered only then.
  const [baseline, setBaseline] = useState<FormBaseline | null>(null);
  // Controlled so the passport tab can send the seller back to Profile.
  const [tab, setTab] = useState<string>(DEFAULT_TAB);
  const seeded = useRef(false);
  const confirm = useConfirm();

  function seedText(p: Pick<VerifiedProfile, "handle" | "display_name" | "bio">) {
    const next = {
      handle: p.handle ?? "",
      displayName: p.display_name ?? "",
      bio: p.bio ?? "",
    };
    setHandle(next.handle);
    setDisplayName(next.displayName);
    setBio(next.bio);
    setBaseline(next);
  }

  // Seed the form once the profile loads.
  useEffect(() => {
    if (!data || seeded.current) return;
    seedText(data.profile);
    setEnabled(data.profile.enabled);
    setShowListings(data.profile.show_listings);
    setEmbedInListings(data.profile.embed_in_listings);
    seeded.current = true;
  }, [data]);

  const savedHandle = data?.profile.handle ?? null;
  const accountName = data?.profile.account_name?.trim() || null;
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
        // Fail closed: an unanswered check must not leave Save enabled.
        setAvailability({
          state: "error",
          reason: "Couldn't check that handle. Try again.",
        });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [normalizedHandle, savedHandle, handleFormat]);

  const isDirty =
    !!baseline &&
    (normalizedHandle !== baseline.handle ||
      displayName.trim() !== baseline.displayName.trim() ||
      bio.trim() !== baseline.bio.trim());
  const guard = useNavigationGuard(isDirty);

  // The form only reflects the real profile once it has been seeded from it.
  // Before that (still loading, or the load failed) a save would write blanks
  // over the live profile, so nothing may be sent.
  const canSave =
    seeded.current &&
    isDirty &&
    !!normalizedHandle &&
    (handleFormat?.ok ?? false) &&
    availability.state !== "checking" &&
    availability.state !== "error";

  async function handleSave() {
    if (!seeded.current) return;
    // Renaming a live handle breaks every badge and link already pasted with
    // the old one (there are no redirects yet), so it is confirmed first.
    const renamingLive =
      !!savedHandle && !!data?.profile.enabled && normalizedHandle !== savedHandle;
    if (renamingLive) {
      const ok = await confirm({
        title: "Change your handle?",
        description: `Badges and links you already pasted use /verified/${savedHandle}. They will stop working after this change.`,
        confirmLabel: "Change handle",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      const saved = await update.mutateAsync({
        handle: normalizedHandle,
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
      });
      if (saved) seedText(saved);
      toast.success("Profile saved");
    } catch {
      // useUpdateVerifiedProfile's onError already told the seller why; the
      // form keeps their edits so nothing typed is lost.
    }
  }

  // The switch sends ONLY the flag. The server falls back to the stored
  // handle, so a half-typed, unchecked handle in the box is never saved by
  // flipping this.
  const handleDirty = !!savedHandle && normalizedHandle !== savedHandle;

  async function handleToggle(next: boolean) {
    if (!seeded.current) return;
    // Reflect immediately; revert on failure.
    setEnabled(next);
    try {
      await update.mutateAsync({ enabled: next });
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

  async function handleEmbedInListingsToggle(next: boolean) {
    setEmbedInListings(next);
    try {
      await update.mutateAsync({ embed_in_listings: next });
    } catch {
      setEmbedInListings(!next);
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

  // Only when there is nothing to show. A failed BACKGROUND refetch (window
  // focus, a save's invalidation) leaves the last good profile in `data`, and
  // swapping the form for this card mid-edit would hide what the seller typed.
  if (!data) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your Verified profile didn't load.</CardTitle>
            <CardDescription>
              Nothing was changed. Try again to load it before you edit anything.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => refetch()} disabled={isFetching}>
              {isFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isLive = enabled && !!savedHandle;

  const steps = readinessSteps({
    handle: savedHandle,
    bio: data.profile.bio,
    enabled,
    embedInListings,
    graded: data.stats.total_graded,
    badgeClicks: funnel.data?.totalClicks ?? null,
  });

  function goToStep(id: ReadinessStepId) {
    if (id === "click") {
      setTab("badges");
      return;
    }
    setTab("profile");
    const target: Record<string, string> = {
      handle: "#handle",
      bio: "#bio",
      public: '[aria-labelledby="public-switch-label"]',
      listings: '[aria-labelledby="embed-switch-label"]',
    };
    const el = document.querySelector<HTMLElement>(target[id] ?? "");
    el?.scrollIntoView?.({ block: "center" });
    el?.focus();
  }
  const liveUrl = savedHandle ? profileUrl(savedHandle) : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-brand-navy dark:text-foreground" />
          <h1 className="text-2xl font-bold">GradeThread Verified</h1>
          <PageHelp slug="becoming-a-verified-seller" />
        </div>
        <p className="text-muted-foreground">
          Turn the grades you've earned into a public profile buyers can
          check, and a badge you add to your listings. Buyers can't fake a
          grade, so it gives them a reason to buy from you.
        </p>
      </div>

      {/* US-2543 AC2: seven stacked panels, so the badge tools sat below three
          screens of profile setup and the identity control below those. Three
          tabs, most-used first. */}
      <UnsavedChangesDialog guard={guard} noun="profile change" />

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="badges">Badges</TabsTrigger>
          <TabsTrigger value="passport">Passport identity</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
      <ReadinessStrip steps={steps} onStep={goToStep} />

      {/* US-2543 AC4: what the handle, name and bio you are typing actually
          look like. The standalone stats grid that used to sit here is inside
          it: the same two numbers, shown where they appear to a buyer. */}
      <VerifiedProfilePreview
        handle={normalizedHandle}
        savedHandle={savedHandle}
        displayName={displayName}
        bio={bio}
        isLive={isLive}
        totalGraded={data?.stats.total_graded ?? 0}
        averageGrade={data?.stats.average_grade ?? 0}
        showListings={showListings}
      />

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
                  aria-describedby="handle-status"
                  aria-invalid={availability.state === "error" || undefined}
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
            {/* Always mounted, so screen readers announce each change. */}
            <p
              id="handle-status"
              role="status"
              className={
                availability.state === "error"
                  ? "text-xs text-red-600 dark:text-red-400"
                  : availability.state === "ok"
                    ? "text-xs text-green-600 dark:text-green-400"
                    : "text-xs text-muted-foreground"
              }
            >
              {availability.state === "error"
                ? availability.reason
                : availability.state === "ok"
                  ? "Available"
                  : availability.state === "checking"
                    ? "Checking..."
                    : ""}
            </p>
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
            {!displayName.trim() && accountName && (
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => setDisplayName(accountName.slice(0, 60))}
              >
                Use my account name ({accountName})
              </Button>
            )}
          </div>

          {/* Bio */}
          <div className="space-y-1.5">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              value={bio}
              maxLength={280}
              rows={3}
              aria-describedby="bio-count"
              placeholder="What you sell and your story. Keep it short (280 characters)."
              onChange={(e) => setBio(e.target.value)}
            />
            <p id="bio-count" className="text-right text-xs text-muted-foreground">
              {bio.length}/280
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSave} disabled={!canSave || update.isPending}>
              {update.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save profile
            </Button>
            {isDirty && (
              <span className="text-sm text-muted-foreground">Unsaved changes</span>
            )}
          </div>
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
          <div className="divide-y">
          <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
            <div className="space-y-0.5">
              <p id="public-switch-label" className="font-medium">Public profile</p>
              <p id="public-switch-hint" className="text-sm text-muted-foreground">
                {!savedHandle
                  ? "Save a handle first to enable this."
                  : handleDirty
                    ? "Save your handle change first."
                    : "Your profile is reachable at your handle URL."}
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={!savedHandle || handleDirty || update.isPending}
              onCheckedChange={handleToggle}
              aria-labelledby="public-switch-label"
              aria-describedby="public-switch-hint"
            />
          </div>

          {/* Storefront opt-in: turns the profile into a shop. Only meaningful
              once the profile is public. */}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="space-y-0.5">
              <p id="storefront-switch-label" className="font-medium">Show my listings (storefront)</p>
              <p id="storefront-switch-hint" className="text-sm text-muted-foreground">
                List your active items on your profile. Graded items show their
                grade and link to the certificate. The rest link to their
                marketplace listing.
              </p>
            </div>
            <Switch
              checked={isLive && showListings}
              disabled={!isLive || update.isPending}
              onCheckedChange={handleShowListingsToggle}
              aria-labelledby="storefront-switch-label"
              aria-describedby="storefront-switch-hint"
            />
          </div>

          {/* US-1126: auto-embed verified credentials in generated listing
              descriptions. Only meaningful once the profile is public. */}
          <div className="flex items-center justify-between gap-4 py-3">
            <div className="space-y-0.5">
              <p id="embed-switch-label" className="font-medium">Add my credentials to listings</p>
              <p id="embed-switch-hint" className="text-sm text-muted-foreground">
                Add your Verified badge to every description FlipDesk writes,
                on eBay and everywhere else. It shows how many grades you have
                earned, your average, and a link back to this page.
              </p>
            </div>
            <Switch
              checked={isLive && embedInListings}
              disabled={!isLive || update.isPending}
              onCheckedChange={handleEmbedInListingsToggle}
              aria-labelledby="embed-switch-label"
              aria-describedby="embed-switch-hint"
            />
          </div>
          </div>

          {/* While private, both switches read Off: they have no effect, and
              showing On would say otherwise. The saved choice comes back when
              the profile goes public. */}
          {!isLive && (
            <p className="text-sm text-muted-foreground">
              These turn back on when your profile is public.
            </p>
          )}

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
              {savedHandle && <ProfileQrBlock handle={savedHandle} />}
            </div>
          )}
        </CardContent>
      </Card>

        </TabsContent>

        <TabsContent value="badges" className="space-y-6">
      {/* Embed: profile badge */}
      {isLive && savedHandle && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BadgeCheck className="h-5 w-5 text-brand-navy dark:text-foreground" />
              Embed your "Verified Seller" badge
            </CardTitle>
            <CardDescription>
              It links buyers to your verified profile. Use the HTML on eBay
              and your own website. Poshmark, Mercari, Depop and Grailed strip
              HTML, so use the text version there and in your bio.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CopyField
              label="HTML (eBay and your own website)"
              value={profileLinkEmbedHtml(savedHandle)}
              multiline
            />
            <CopyField
              label="Text + link (Poshmark, Mercari, Depop, Grailed, bios)"
              value={verifiedSellerBadgeEmbedText(savedHandle)}
              multiline
            />
            <p className="text-sm text-muted-foreground">
              For a <strong>per-item</strong> grade badge, use the Badge Studio
              below. Buyers see the exact condition grade for that listing.
            </p>
          </CardContent>
        </Card>
      )}

      {/* US-1760: badge funnel: clicks by source + referral conversions. */}
      {isLive && <BadgePerformanceCard />}

      {/* US-1759/1761: badge studio: storefront (when public), per-item cert
          and passport snippets. */}
      <div id="badge-studio" className="scroll-mt-6">
        <BadgeStudio handle={isLive ? savedHandle : null} />
      </div>
        </TabsContent>

        <TabsContent value="passport" className="space-y-6">
      {/* US-1105: opt-in identity reveal on Garment Passports. */}
      <PassportIdentityCard
        profilePublic={isLive}
        onGoToProfile={() => setTab("profile")}
      />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// US-1760: the seller's badge funnel: how much traffic + signups their embedded
// badges drove. Clicks are attributed from the ?s= source when a buyer lands on a
// certificate or this profile from an off-platform badge; conversions reuse the
// referral ledger. The card is always shown once the profile is live: an error
// says so with Retry, and no clicks yet is an explained empty state rather than
// a card that silently is not there.
const SOURCE_LABELS: Record<string, string> = {
  embed: "Listing embeds",
  badge: "Profile badge",
  qr: "QR code scans",
  buyer: "GradeThread buyer tools",
  share: "Shared links",
};

function badgeSourceLabel(src: string): string {
  return SOURCE_LABELS[src] ?? src;
}

function BadgePerformanceCard() {
  const { data, isLoading, refetch, isFetching } = useBadgeFunnel();
  if (isLoading) return <Skeleton className="h-32 w-full" />;

  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <BadgeCheck className="h-5 w-5 text-brand-navy dark:text-foreground" />
        Badge performance
      </CardTitle>
      {data && (
        <CardDescription>
          Traffic and signups your embedded badges drove in the last {data.windowDays} days.
          Your own clicks on certificate badges are not counted.
        </CardDescription>
      )}
    </CardHeader>
  );

  // Last good numbers stay up if only a background refetch failed.
  if (!data) {
    return (
      <Card>
        {header}
        <CardContent>
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <span>Couldn't load badge stats.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (data.totalClicks === 0 && data.conversions === 0) {
    return (
      <Card>
        {header}
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No badge clicks yet. Paste a badge from{" "}
            <a
              href="#badge-studio"
              className="font-medium text-brand-navy underline dark:text-foreground"
            >
              Badge Studio below
            </a>{" "}
            into a listing and clicks show up here.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sources = Object.entries(data.clicksBySource).sort((a, b) => b[1] - a[1]);
  const variants = data.clicksByVariant ?? null;
  return (
    <Card>
      {header}
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-3xl font-extrabold text-brand-navy dark:text-foreground">
              {data.totalClicks}
            </div>
            <p className="text-sm text-muted-foreground">badge clicks</p>
          </div>
          <div>
            <div className="text-3xl font-extrabold text-brand-navy dark:text-foreground">
              {data.conversions}
            </div>
            <p className="text-sm text-muted-foreground">Referral signups (all channels)</p>
          </div>
        </div>
        {sources.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Clicks by source</p>
            {sources.map(([src, n]) => {
              const share = data.totalClicks > 0 ? Math.round((n / data.totalClicks) * 100) : 0;
              return (
                <div key={src} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{badgeSourceLabel(src)}</span>
                    <span className="font-medium tabular-nums">{n}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden="true">
                    <div
                      className="h-1.5 rounded-full bg-brand-navy dark:bg-foreground"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* US-1913 AC5: the A/B a seller actually wants: does putting my
            standing on the badge earn more clicks than the plain one? Shown
            only once at least one status badge has been clicked, so a seller
            who never turned it on isn't asked to read a row of zeroes. */}
        {variants && variants.status > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">
              Clicks by badge format
            </p>
            <div className="flex items-center justify-between text-sm">
              <span>Plain badge</span>
              <span className="font-medium tabular-nums">{variants.plain}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>With your status</span>
              <span className="font-medium tabular-nums">{variants.status}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// V14: a printable, tracked link for packing slips, pop-ups and live sales.
// Scans arrive with ?s=qr, which is already a funnel source, so they show up in
// Badge performance as "QR code scans".
function ProfileQrBlock({ handle }: { handle: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const value = profileShareUrl(handle, "qr");
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  function download() {
    const canvas = wrapRef.current?.querySelector("canvas");
    let url: string | undefined;
    try {
      url = canvas?.toDataURL("image/png");
    } catch {
      url = undefined;
    }
    if (!url) {
      toast.error("Couldn't make the image. Try again.");
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = profileQrFilename(handle);
    a.click();
  }

  async function share() {
    try {
      await navigator.share({ title: "My GradeThread Verified profile", url: value });
    } catch {
      // The seller closed the share sheet; nothing to report.
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4 pt-2">
      <div ref={wrapRef} className="rounded-md bg-white p-2">
        <QRCodeCanvas
          value={value}
          size={128}
          marginSize={1}
          role="img"
          aria-label="QR code for your profile"
        />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">QR code</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Print it on packing slips or show it at a pop-up. Scans are counted in
          Badge performance.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={download}>
            Download PNG
          </Button>
          {canShare && (
            <Button type="button" variant="outline" size="sm" onClick={share}>
              Share
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A human-readable garment name from the PII-free sku_class descriptor. */
function garmentName(sku: Record<string, unknown>): string {
  const brand = typeof sku.brand === "string" ? sku.brand.trim() : "";
  const type = typeof sku.garment_type === "string" ? sku.garment_type.trim() : "";
  const pretty = type
    ? type.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    : "";
  const parts = [brand, pretty].filter(Boolean);
  return parts.length ? parts.join(" ") : "Graded garment";
}

// Lets the seller reveal their public Verified identity on chosen passport hops.
// Strictly opt-in, OFF by default, reversible, and per-hop (US-1105). Only
// meaningful once the Verified profile is public; otherwise there is no public
// handle to show, so the toggles are disabled with a way back to the Profile
// tab. An error and an empty list each say what they are, rather than leaving
// the tab blank.
function PassportIdentityCard({
  profilePublic,
  onGoToProfile,
}: {
  profilePublic: boolean;
  onGoToProfile: () => void;
}) {
  const { data, isLoading, refetch, isFetching } = usePassportIdentityNodes();
  const setReveal = useSetPassportReveal();
  // One entry per hop with a request in flight, so two quick toggles on two
  // hops each stay disabled until their own request settles.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());

  async function toggle(node: PassportIdentityNode, next: boolean) {
    setPendingIds((prev) => new Set(prev).add(node.node_id));
    try {
      await setReveal.mutateAsync({ nodeId: node.node_id, revealed: next });
    } catch {
      // The hook rolls the hop back and tells the seller why.
    } finally {
      setPendingIds((prev) => {
        const out = new Set(prev);
        out.delete(node.node_id);
        return out;
      });
    }
  }

  // The server is the source of truth for whether revealing is possible right
  // now; fall back to the locally-known publish state while loading.
  const canReveal = data?.verified_profile_public ?? profilePublic;
  const nodes = data?.nodes ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Eye className="h-5 w-5 text-brand-navy dark:text-foreground" />
          Reveal your identity on passports
        </CardTitle>
        <CardDescription>
          A Garment Passport is the public history of one item. Passports hide
          who owned the item by default. You can choose, item by item, to show
          your Verified handle on its history, so buyers can see the items
          you've owned and graded. You can turn this off at any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !data ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
            <span>Couldn't load your passports.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              Retry
            </Button>
          </div>
        ) : nodes.length === 0 ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              You don't have any passports yet. A passport is created when an
              item you own is graded, and it shows up here after that.
            </p>
            <Link
              to="/dashboard/submissions/new"
              className="inline-flex font-medium text-brand-navy hover:underline dark:text-foreground"
            >
              Grade an item
            </Link>
          </div>
        ) : (
          <>
            {!canReveal && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span>Make your Verified profile public first. A reveal shows that handle.</span>
                <Button type="button" variant="outline" size="sm" onClick={onGoToProfile}>
                  Go to your profile
                </Button>
              </div>
            )}
            {data.garments_unavailable && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Item names couldn't load right now, so some items show a
                general name.
              </p>
            )}
            <ul className="divide-y">
              {nodes.map((node) => {
                const busy = pendingIds.has(node.node_id);
                return (
                  <li
                    key={node.node_id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate font-medium">{garmentName(node.sku_class)}</p>
                      <p className="text-xs text-muted-foreground">
                        {node.label}
                        {node.revealed && !node.revealed_effective && (
                          <span className="ml-1 text-amber-600 dark:text-amber-400">
                            · hidden until your profile is public
                          </span>
                        )}
                      </p>
                      {node.passport_slug && (
                        <a
                          href={`/passport/${encodeURIComponent(node.passport_slug)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-brand-navy hover:underline dark:text-foreground"
                        >
                          <History className="h-3.5 w-3.5" />
                          View passport
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      <Switch
                        checked={node.revealed}
                        disabled={busy || (!node.revealed && !canReveal)}
                        onCheckedChange={(next) => toggle(node, next)}
                        aria-label={`Reveal identity on ${garmentName(node.sku_class)}`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
