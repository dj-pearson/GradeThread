// US-1579: the MeasureCard tools page — what the card is, how to shoot with
// it, the free print-at-home PDF, and (paid plans) request-a-mailed-card.
// Addresses go straight to the edge (deny-all operator table) and are never
// echoed back — the status card shows progress only.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  Check,
  Download,
  Loader2,
  Mail,
  Ruler,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { edgeFetch } from "@/lib/edge-fetch";
import { useWorkspace } from "@/hooks/use-workspace";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MeasureCardDiagram } from "@/components/flipdesk/measure-card-diagram";
import { PageHelp } from "@/components/help/page-help";

interface CardRequest {
  id: string;
  status: "requested" | "exported" | "shipped";
  card_version: number;
  requested_at: string;
  shipped_at: string | null;
  // US-2231: the seller's own parcel. 00561 added the columns, the route has
  // returned them since, and this interface did not declare them — so the one
  // person the number is FOR never saw it. The route's own comment says "the
  // page renders nothing rather than an empty link", which was true in the way
  // that hides a gap: it rendered nothing for every request, tracked or not.
  tracking_number: string | null;
  tracking_carrier: string | null;
}

// MC-01: the server decides who may request a card, from the WORKSPACE OWNER's
// plan and the caller's role. The page used to read the signed-in user's own
// plan, which is the wrong tenant for any workspace member.
type CardRequestEligibilityReason =
  | "ok"
  | "free_plan"
  | "active_request"
  | "viewer";

interface CardRequestState {
  request: CardRequest | null;
  eligibility: {
    can_request: boolean;
    reason: CardRequestEligibilityReason;
  };
  // MC-10: the owner's cataloged items (null when the count failed) and the
  // card on record for the owner, returned by the same GET.
  waiting_count?: number | null;
  card?: { source: "download" | "mail" | null; version: number | null };
}

const CAPTURE_DOS = [
  "Lay the garment flat and place the card BESIDE it (never on top)",
  "Shoot top-down with all four black squares fully visible",
  "Use even lighting — no hard shadows across the card",
  "Keep the card flat; a bent card skews every measurement",
];

const CAPTURE_DONTS = [
  "Don't crop or cover any corner square",
  "Don't shoot at a steep angle — straight down beats artsy",
  "Don't scale the print — the PDF must print at 100% size",
];

// US-2540: where a card can be posted. Deliberately a SHORT list rather than
// every ISO country: each one here is somewhere the fulfilment run actually
// posts to, and offering a country we cannot ship to is the same defect this
// story is about, just pointing the other way. The server stores a 2-letter
// code and the fulfilment CSV already exports it (admin-measure-cards.ts), so
// adding a country is one line here.
const MAIL_COUNTRIES: { code: string; name: string }[] = [
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
];

// MC-08: the longest value the server accepts for each field. MIRRORED from
// MAIL_FIELD_LIMITS in services/edge-functions/src/routes/flipdesk-measure.ts
// the same way MAIL_COUNTRIES is; a Vitest guard compares the two. The server
// refuses anything longer rather than shortening it, so the input stops the
// seller at the limit instead of letting them type an address we will bounce.
const MAIL_FIELD_LIMITS = {
  ship_name: 120,
  address_line1: 200,
  address_line2: 200,
  city: 120,
  state: 80,
  postal_code: 20,
} as const;

// MC-08: where an address has a state / province line. MIRRORED from
// STATE_REQUIRED_COUNTRIES on the server. Elsewhere it is optional.
const STATE_REQUIRED_COUNTRIES = ["US", "CA", "AU"] as const;

const STATUS_LABEL: Record<CardRequest["status"], string> = {
  requested: "Requested — in the fulfillment queue",
  exported: "Sent to the print vendor",
  shipped: "Shipped",
};

export function FlipdeskMeasureCardPage() {
  const { workspaceOwnerId } = useWorkspace();
  const qc = useQueryClient();
  const queryKey = ["measure_card_request", workspaceOwnerId] as const;

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: async (): Promise<CardRequestState> => {
      const res = await edgeFetch("/api/flipdesk/measure/card-request");
      // US-2540: this used to `return null` on any failure, which is the same
      // value as "you have never requested one" — so a seller whose request was
      // already in the queue was shown the form again, and the server answered
      // their second attempt with a 409 they had no way to anticipate.
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? "Could not check your card request.");
      }
      return (await res.json()) as CardRequestState;
    },
    // MC-07: shipped and tracking are set by the operator, so a seller coming
    // back to the tab should see them without waiting out the default 5 min.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const request = data?.request ?? null;
  const reason = data?.eligibility.reason ?? "free_plan";
  const waitingCount = data?.waiting_count ?? null;
  const cardSource = data?.card?.source ?? null;
  const cardVersion = data?.card?.version ?? null;
  // MC-10: once the owner has a card (printed or requested), the how-to is
  // reference material and starts folded away.
  const isSetUp = Boolean(request || cardSource);

  const [form, setForm] = useState({
    ship_name: "",
    address_line1: "",
    address_line2: "",
    city: "",
    state: "",
    postal_code: "",
    // US-2540: the server and the table have always had this column (default
    // 'US'); the form simply never sent it, so every request looked domestic
    // whoever made it.
    country: "US",
  });
  const [submitting, setSubmitting] = useState(false);
  // MC-08: the address is never echoed back by the server, so this is the
  // seller's only chance to catch a typo before a card goes to the wrong door.
  const [reviewing, setReviewing] = useState(false);
  // MC-09: a shipped card can be replaced by opening the same form again.
  const [replacing, setReplacing] = useState(false);
  const isUs = form.country === "US";
  const needsState = (STATE_REQUIRED_COUNTRIES as readonly string[]).includes(
    form.country,
  );
  const countryName =
    MAIL_COUNTRIES.find((c) => c.code === form.country)?.name ?? form.country;

  function set(key: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  function startReview(e: React.FormEvent) {
    e.preventDefault();
    setReviewing(true);
  }

  async function submitRequest() {
    setSubmitting(true);
    try {
      const res = await edgeFetch("/api/flipdesk/measure/card-request", {
        method: "POST",
        json: form,
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
        request?: CardRequest;
      };
      if (!res.ok) {
        toast.error(json.error ?? "Could not submit the request.");
        // A field the server refused has to be edited, so go back to the form.
        if (json.fields) setReviewing(false);
        return;
      }
      setReviewing(false);
      setReplacing(false);
      toast.success("Card request received — we'll mail it out shortly.");
      // MC-07: the POST already returns the new request, so use it rather
      // than paying for a second GET to learn what we were just told.
      if (json.request) {
        const created = json.request;
        qc.setQueryData<CardRequestState>(queryKey, (prev) => ({
          ...prev,
          request: created,
          eligibility: { can_request: false, reason: "active_request" },
        }));
      } else {
        await qc.invalidateQueries({ queryKey });
      }
    } finally {
      setSubmitting(false);
    }
  }

  function downloadPdf() {
    // Stamp the profile record (best-effort) and open the bundled PDF.
    void edgeFetch("/api/flipdesk/measure/card-downloaded", {
      method: "POST",
      json: {},
    }).catch(() => {});
    window.open("/measure-card-letter-v2.pdf", "_blank");
  }

  const activeRequest = request && request.status !== "shipped" ? request : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6">
      <PageHeader
        icon={Ruler}
        title="MeasureCard"
        subtitle="Lay the card beside a garment, take one photo, and we read the measurements."
        actions={<PageHelp slug="using-the-measurecard" />}
      />

      {/* MC-10: the work that is waiting comes first, with the page's only
          primary button. US-2231 AC1 is why it exists at all: the page used
          to describe the card and dead-end.

          ?status=cataloged lands on the Unlisted tab (statusParamToTab folds
          every pre-listed stage into it) filtered to cataloged, which is the
          set waiting_count counts. status is the documented external entry
          point, so the link survives a tab rename. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Measure an item</CardTitle>
          <CardDescription>
            Measurements are captured on the item itself, next to its photos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {waitingCount === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing waiting. Catalog an item first.
            </p>
          ) : (
            <Button asChild>
              <Link to="/dashboard/flipdesk/inventory?status=cataloged">
                <Ruler className="mr-2 h-4 w-4" />
                {waitingCount == null
                  ? "Go to items ready to measure"
                  : `${waitingCount} ${waitingCount === 1 ? "item" : "items"} waiting to be measured`}
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>

      {/* MC-10: the seller's card setup, stated as a fact the page knows. */}
      {!isLoading && !isError ? (
        <p className="text-sm text-muted-foreground" data-testid="mc-your-card">
          {cardSource
            ? `Your card: v${cardVersion ?? "?"}, ${cardSource === "mail" ? "mailed to you" : "printed at home"}.`
            : request
              ? "Your card is on its way by mail."
              : "No card yet. Print one below, or request one by mail."}
        </p>
      ) : null}

      <details
        open={!isSetUp}
        className="group rounded-xl border bg-card text-card-foreground"
      >
        <summary className="cursor-pointer px-6 py-4 text-base font-semibold">
          How to shoot with it
        </summary>
        <div className="space-y-4 px-6 pb-6">
          <p className="text-sm text-muted-foreground">
            One photo: the garment flat, the card beside it, camera top-down.
          </p>
          {/* US-2540: the instructions said "all four black squares" to people
              who had never seen one. */}
          <MeasureCardDiagram className="mx-auto max-w-sm" />
          <div className="grid gap-4 sm:grid-cols-2">
            <ul className="space-y-1.5 text-sm">
              {CAPTURE_DOS.map((d) => (
                <li key={d} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  {d}
                </li>
              ))}
            </ul>
            <ul className="space-y-1.5 text-sm">
              {CAPTURE_DONTS.map((d) => (
                <li key={d} className="flex gap-2">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  {d}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Print at home (free)</CardTitle>
          <CardDescription>
            US-Letter PDF. Print at <strong>100% scale</strong> (no
            &quot;fit to page&quot;) on matte paper, then verify with the
            built-in credit-card check box before first use.
            {/* US-2540: the page said "US-Letter" and left a seller with A4
                paper to guess. The card artwork is 7.5in x 5.5in — 191mm x
                140mm — so it fits inside A4's printable area with room to
                spare, and the only thing that breaks it is the scaling that
                "fit to page" applies. That is worth saying out loud. */}{" "}
            <strong>On A4:</strong> print the same file and choose
            &quot;Actual size&quot; or 100% — the card is 191mm × 140mm, well
            inside A4, and only scaling would break the calibration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={downloadPdf}>
            <Download className="mr-2 h-4 w-4" />
            Download the print-at-home PDF
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Get a card mailed to you</CardTitle>
          <CardDescription>
            Professionally printed on rigid matte stock — the most accurate
            option. Included with paid plans. Cards post from the United
            States, so delivery elsewhere takes longer; the print-at-home PDF
            above uses the same pipeline and works today.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          ) : isError ? (
            // US-2540: a failed read is NOT "you have no request". Offering the
            // form here is how a seller sends a second request and meets a 409.
            <ErrorState
              title="Couldn't check your card request"
              description="We can't tell whether you already have one on the way, so the form is hidden until this loads."
              onRetry={() => refetch()}
              retrying={isFetching}
              hideSupport
            />
          ) : activeRequest ? (
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="outline" className="gap-1">
                <Mail className="h-3 w-3" />
                {STATUS_LABEL[activeRequest.status]}
              </Badge>
              <span className="text-muted-foreground">
                Requested {new Date(activeRequest.requested_at).toLocaleDateString()}
              </span>
            </div>
          ) : request?.status === "shipped" && !replacing ? (
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p>
                Your card (v{request.card_version}) shipped
                {request.shipped_at
                  ? ` on ${new Date(request.shipped_at).toLocaleDateString()}`
                  : ""}
                .
              </p>
              {/* Most cards go as untracked letters, so NULL is the normal case
                  and this renders nothing at all rather than an empty row.

                  TEXT, NOT A LINK, and that is the decision rather than an
                  omission. Nothing in this repo maps a carrier to a tracking
                  URL, so linking means guessing a URL shape per carrier — and
                  the shape changes without telling us. The migration that added
                  these columns already made the same call about placeholders:
                  a wrong tracking link is worse than none, because the seller
                  clicks it and believes the answer. A number they can select
                  and paste is honest and cannot rot. */}
              {request.tracking_number ? (
                <p>
                  Tracking:{" "}
                  <span className="font-medium text-foreground select-all">
                    {request.tracking_number}
                  </span>
                  {request.tracking_carrier ? ` (${request.tracking_carrier})` : ""}
                </p>
              ) : null}
              {/* MC-09: this used to send the seller to support with no link. The
                  server only blocks while a request is requested or exported,
                  so a new request after shipping already works; offer it. */}
              {reason === "ok" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReplacing(true)}
                >
                  Lost or damaged? Request a replacement card
                </Button>
              ) : null}
            </div>
          ) : reason === "viewer" ? (
            <p className="text-sm text-muted-foreground">
              Only teammates who can edit can request a card.
            </p>
          ) : reason !== "ok" ? (
            <p className="text-sm text-muted-foreground">
              Mailed cards are included with paid plans — the print-at-home PDF
              above works with the same pipeline, or upgrade to have one mailed.
            </p>
          ) : (
            reviewing ? (
            <div className="space-y-3">
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">We will mail it to:</p>
                <address
                  data-testid="mc-review"
                  className="mt-1 not-italic text-muted-foreground"
                >
                  <span className="block text-foreground">{form.ship_name}</span>
                  <span className="block">{form.address_line1}</span>
                  {form.address_line2 ? (
                    <span className="block">{form.address_line2}</span>
                  ) : null}
                  <span className="block">
                    {[form.city, form.state, form.postal_code]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                  <span className="block">{countryName}</span>
                </address>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setReviewing(false)}
                  disabled={submitting}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  onClick={() => void submitRequest()}
                  disabled={submitting}
                >
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm and request
                </Button>
              </div>
            </div>
            ) : (
            <form onSubmit={startReview} className="grid gap-3 sm:grid-cols-2">
              {/* MC-08: country first, because it decides what the fields
                  below are called and whether a state is needed. */}
              <div className="sm:col-span-2 space-y-1">
                <Label htmlFor="mc-country">Country</Label>
                <Select
                  name="country"
                  autoComplete="country"
                  value={form.country}
                  onValueChange={(v) => set("country", v)}
                >
                  <SelectTrigger id="mc-country">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MAIL_COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2 space-y-1">
                <Label htmlFor="mc-name">Full name</Label>
                <Input
                  id="mc-name"
                  autoComplete="name"
                  maxLength={MAIL_FIELD_LIMITS.ship_name}
                  value={form.ship_name}
                  onChange={(e) => set("ship_name", e.target.value)}
                  required
                />
              </div>
              <div className="sm:col-span-2 space-y-1">
                <Label htmlFor="mc-a1">Address line 1</Label>
                <Input
                  id="mc-a1"
                  autoComplete="address-line1"
                  maxLength={MAIL_FIELD_LIMITS.address_line1}
                  value={form.address_line1}
                  onChange={(e) => set("address_line1", e.target.value)}
                  required
                />
              </div>
              <div className="sm:col-span-2 space-y-1">
                <Label htmlFor="mc-a2">Address line 2 (optional)</Label>
                <Input
                  id="mc-a2"
                  autoComplete="address-line2"
                  maxLength={MAIL_FIELD_LIMITS.address_line2}
                  value={form.address_line2}
                  onChange={(e) => set("address_line2", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mc-city">City</Label>
                <Input
                  id="mc-city"
                  autoComplete="address-level2"
                  maxLength={MAIL_FIELD_LIMITS.city}
                  value={form.city}
                  onChange={(e) => set("city", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                {/* US-2540: "State" and "ZIP" are US words. MC-08: and only
                    US, CA and AU addresses need the line at all. */}
                <Label htmlFor="mc-state">
                  {isUs
                    ? "State"
                    : needsState
                      ? "State / Province / Region"
                      : "State / Province / Region (optional)"}
                </Label>
                <Input
                  id="mc-state"
                  autoComplete="address-level1"
                  maxLength={MAIL_FIELD_LIMITS.state}
                  value={form.state}
                  onChange={(e) => set("state", e.target.value)}
                  required={needsState}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mc-zip">{isUs ? "ZIP" : "Postal code"}</Label>
                <Input
                  id="mc-zip"
                  autoComplete="postal-code"
                  inputMode={isUs ? "numeric" : "text"}
                  maxLength={MAIL_FIELD_LIMITS.postal_code}
                  value={form.postal_code}
                  onChange={(e) => set("postal_code", e.target.value)}
                  required
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" variant="outline">
                  Review address
                </Button>
              </div>
            </form>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
