import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  useVerifiedProfile,
  useUpdateVerifiedProfile,
  useBadgeFunnel,
  checkHandleAvailable,
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
} from "@/lib/verified";
import { SITE_URL } from "@/lib/seo/site";
import { PageHelp } from "@/components/help/page-help";

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
  const [embedInListings, setEmbedInListings] = useState(false);
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
    setEmbedInListings(data.profile.embed_in_listings);
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

  const isLive = enabled && !!savedHandle;
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
          Turn every grade you've earned into a public trust profile buyers can
          verify — and a badge you embed in your listings. The grade buyers can't
          fake becomes the reason they buy from you.
        </p>
      </div>

      {/* US-2543 AC2: seven stacked panels, so the badge tools sat below three
          screens of profile setup and the identity control below those. Three
          tabs, most-used first. */}
      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="badges">Badges</TabsTrigger>
          <TabsTrigger value="passport">Passport identity</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-6">
      {/* US-2543 AC4: what the handle, name and bio you are typing actually
          look like. The standalone stats grid that used to sit here is inside
          it — the same two numbers, shown where they appear to a buyer. */}
      <VerifiedProfilePreview
        handle={normalizedHandle}
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

          {/* US-1126: auto-embed verified credentials in generated listing
              descriptions. Only meaningful once the profile is public. */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">Add my credentials to listings</p>
              <p className="text-sm text-muted-foreground">
                Automatically embed your verified badge — grades earned, average
                grade and a link to this profile — into the descriptions FlipDesk
                generates for eBay and every other marketplace.
              </p>
            </div>
            <Switch
              checked={embedInListings}
              disabled={!isLive || update.isPending}
              onCheckedChange={handleEmbedInListingsToggle}
              aria-label="Toggle embedding credentials in listings"
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
              For a <strong>per-item</strong> grade badge, use the Badge Studio
              below — buyers see the exact condition grade for that listing.
            </p>
          </CardContent>
        </Card>
      )}

      {/* US-1760: badge funnel — clicks by source + referral conversions. */}
      {isLive && <BadgePerformanceCard />}

      {/* US-1759/1761: badge studio — storefront (when public), per-item cert
          and passport snippets. */}
      <BadgeStudio handle={isLive ? savedHandle : null} />
        </TabsContent>

        <TabsContent value="passport" className="space-y-6">
      {/* US-1105: opt-in identity reveal on Garment Passports. */}
      <PassportIdentityCard profilePublic={isLive} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// US-1760: the seller's badge funnel — how much traffic + signups their embedded
// badges drove. Clicks are attributed from the ?s= source when a buyer lands on a
// certificate or this profile from an off-platform badge; conversions reuse the
// referral ledger. Hidden until there's data so it never shows an empty shell.
function BadgePerformanceCard() {
  const { data, isLoading } = useBadgeFunnel();
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!data || (data.totalClicks === 0 && data.conversions === 0)) return null;

  const sources = Object.entries(data.clicksBySource).sort((a, b) => b[1] - a[1]);
  const variants = data.clicksByVariant ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgeCheck className="h-5 w-5 text-brand-navy dark:text-foreground" />
          Badge performance
        </CardTitle>
        <CardDescription>
          Traffic and signups your embedded badges drove in the last {data.windowDays} days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border p-4">
            <div className="text-3xl font-extrabold text-brand-navy dark:text-foreground">
              {data.totalClicks}
            </div>
            <p className="text-sm text-muted-foreground">badge clicks</p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="text-3xl font-extrabold text-brand-navy dark:text-foreground">
              {data.conversions}
            </div>
            <p className="text-sm text-muted-foreground">referred signups</p>
          </div>
        </div>
        {sources.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted-foreground">Clicks by source</p>
            {sources.map(([src, n]) => (
              <div key={src} className="flex items-center justify-between text-sm">
                <span className="capitalize">{src}</span>
                <span className="font-medium tabular-nums">{n}</span>
              </div>
            ))}
          </div>
        )}
        {/* US-1913 AC5: the A/B a seller actually wants — does putting my
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
// meaningful once the Verified profile above is public — otherwise there's no
// public handle to show, so the toggles are disabled with a prompt.
function PassportIdentityCard({ profilePublic }: { profilePublic: boolean }) {
  const { data, isLoading } = usePassportIdentityNodes();
  const setReveal = useSetPassportReveal();
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Hide the section entirely when the user owns no claimed passport hops —
  // there's nothing to reveal and it would only add noise.
  if (!isLoading && (!data || data.nodes.length === 0)) return null;

  async function toggle(node: PassportIdentityNode, next: boolean) {
    setPendingId(node.node_id);
    try {
      await setReveal.mutateAsync({ nodeId: node.node_id, revealed: next });
    } finally {
      setPendingId(null);
    }
  }

  // The server is the source of truth for whether revealing is possible right
  // now; fall back to the locally-known publish state while loading.
  const canReveal = data?.verified_profile_public ?? profilePublic;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Eye className="h-5 w-5 text-brand-navy dark:text-foreground" />
          Reveal your identity on passports
        </CardTitle>
        <CardDescription>
          Garment Passports are pseudonymous by default. Opt in — per item — to
          show your Verified handle on a garment's public history, so buyers can
          see the items you've owned and graded. You can turn this off any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canReveal && (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Publish your Verified profile above first — that's the handle a reveal
            shows.
          </div>
        )}

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ul className="space-y-3">
            {(data?.nodes ?? []).map((node) => {
              const busy = setReveal.isPending && pendingId === node.node_id;
              return (
                <li
                  key={node.node_id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-4"
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
                        href={`/passport/${node.passport_slug}`}
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
        )}
      </CardContent>
    </Card>
  );
}
