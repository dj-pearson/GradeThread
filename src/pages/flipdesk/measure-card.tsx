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
import { useAuth } from "@/hooks/use-auth";
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

const STATUS_LABEL: Record<CardRequest["status"], string> = {
  requested: "Requested — in the fulfillment queue",
  exported: "Sent to the print vendor",
  shipped: "Shipped",
};

export function FlipdeskMeasureCardPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const plan = profile?.flipdesk_plan ?? "free";
  const mailEligible = plan !== "free";

  const {
    data: request = null,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["measure_card_request"],
    queryFn: async (): Promise<CardRequest | null> => {
      const res = await edgeFetch("/api/flipdesk/measure/card-request");
      // US-2540: this used to `return null` on any failure, which is the same
      // value as "you have never requested one" — so a seller whose request was
      // already in the queue was shown the form again, and the server answered
      // their second attempt with a 409 they had no way to anticipate.
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? "Could not check your card request.");
      }
      const json = (await res.json()) as { request: CardRequest | null };
      return json.request;
    },
  });

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
  const isUs = form.country === "US";

  function set(key: keyof typeof form, v: string) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await edgeFetch("/api/flipdesk/measure/card-request", {
        method: "POST",
        json: form,
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(json.error ?? "Could not submit the request.");
        return;
      }
      toast.success("Card request received — we'll mail it out shortly.");
      await qc.invalidateQueries({ queryKey: ["measure_card_request"] });
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
        subtitle="Print the card and lay it next to the garment. One photo is enough: we read the measurements off the card, you drag to fix any that look wrong, and we add a tidy measurements photo to your listing."
              actions={<PageHelp slug="using-the-measurecard" />}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How to shoot with it</CardTitle>
          <CardDescription>
            One photo: the garment flat, the card beside it, camera top-down.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>

      {/* US-2231 AC1: the page described the capability and dead-ended. Every
          control on it produced an ARTEFACT — a PDF to print, a card to mail —
          and none of them led to the thing the artefact is for. A seller who
          finished reading had to already know that measuring happens on an
          item, and where to find one.

          Points at the To-list tab rather than the inventory root: that is
          where pre-listed items sit (statusParamToTab folds cataloged /
          measured / photographed into it), so the seller lands on the set that
          actually needs measuring instead of their whole catalog. Uses
          ?status=cataloged rather than ?tab=to_list because status is the
          documented external entry point the Overview grid and Kanban links
          already use, and it survives a tab rename. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Measure an item</CardTitle>
          <CardDescription>
            Measurements are captured on the item itself, next to its photos —
            open an item that is ready to list and fill in the measurement
            fields with the card in frame.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/dashboard/flipdesk/inventory?status=cataloged">
              <Ruler className="mr-2 h-4 w-4" />
              Go to items ready to measure
            </Link>
          </Button>
        </CardContent>
      </Card>

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
          <Button onClick={downloadPdf}>
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
          ) : request?.status === "shipped" ? (
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p>
                Your card (v{request.card_version}) shipped
                {request.shipped_at
                  ? ` on ${new Date(request.shipped_at).toLocaleDateString()}`
                  : ""}
                . Need another? Contact support.
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
            </div>
          ) : !mailEligible ? (
            <p className="text-sm text-muted-foreground">
              Mailed cards are included with paid plans — the print-at-home PDF
              above works with the same pipeline, or upgrade to have one mailed.
            </p>
          ) : (
            <form onSubmit={(e) => void submitRequest(e)} className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 space-y-1">
                <Label htmlFor="mc-name">Full name</Label>
                <Input
                  id="mc-name"
                  value={form.ship_name}
                  onChange={(e) => set("ship_name", e.target.value)}
                  required
                />
              </div>
              <div className="sm:col-span-2 space-y-1">
                <Label htmlFor="mc-a1">Address line 1</Label>
                <Input
                  id="mc-a1"
                  value={form.address_line1}
                  onChange={(e) => set("address_line1", e.target.value)}
                  required
                />
              </div>
              <div className="sm:col-span-2 space-y-1">
                <Label htmlFor="mc-a2">Address line 2 (optional)</Label>
                <Input
                  id="mc-a2"
                  value={form.address_line2}
                  onChange={(e) => set("address_line2", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mc-city">City</Label>
                <Input
                  id="mc-city"
                  value={form.city}
                  onChange={(e) => set("city", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                {/* US-2540: "State" and "ZIP" are US words. The field is
                    required, so a seller in a country without either had to
                    invent something to get past it. */}
                <Label htmlFor="mc-state">
                  {isUs ? "State" : "State / Province / Region"}
                </Label>
                <Input
                  id="mc-state"
                  value={form.state}
                  onChange={(e) => set("state", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mc-zip">{isUs ? "ZIP" : "Postal code"}</Label>
                <Input
                  id="mc-zip"
                  value={form.postal_code}
                  onChange={(e) => set("postal_code", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mc-country">Country</Label>
                <Select
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
              <div className="flex items-end">
                <Button type="submit" disabled={submitting}>
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Request my card
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
