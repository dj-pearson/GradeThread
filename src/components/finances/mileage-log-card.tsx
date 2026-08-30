import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Car,
  FileSpreadsheet,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { csvBlob, downloadBlob } from "@/lib/download";
import { escapeCsvCell } from "@/lib/items-csv";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/ledger-math";
import { ymd } from "@/lib/tax-profile";
import {
  deleteTrip,
  fetchMileageSummary,
  fetchRateOn,
  fetchTrips,
  fetchVehicleYear,
  formatRate,
  mileageWarnings,
  partIvConflict,
  partIvRows,
  saveTrip,
  saveVehicleYear,
  type MileageTrip,
} from "@/lib/mileage";

// US-2989 — the mileage log.
//
// It lives under Tax with the 1099-K bridge because both are once-a-year,
// calendar-year surfaces. Mileage rates are published per calendar year and the
// Part IV questions are asked per calendar year, so a fiscal-year period
// selector here would be actively wrong.

interface SourceOption {
  id: string;
  name: string;
  location: string | null;
}

export function MileageLogCard() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MileageTrip | null>(null);

  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;

  const { data: summary, isLoading } = useQuery({
    queryKey: ["mileage-summary", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchMileageSummary(from, to),
  });

  const { data: trips = [] } = useQuery({
    queryKey: ["mileage-trips", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchTrips(from, to),
  });

  const { data: vehicleYear } = useQuery({
    queryKey: ["vehicle-year", user?.id, year],
    enabled: !!user,
    queryFn: () => fetchVehicleYear(year),
  });

  const warnings = summary ? mileageWarnings(summary) : [];
  const conflict = summary
    ? partIvConflict(summary, vehicleYear ?? null)
    : null;
  const method = vehicleYear?.method ?? "standard";

  async function remove(id: string) {
    const ok = await confirm({
      title: "Delete this trip?",
      description:
        "It comes off your mileage log and out of your books. This can't be undone.",
      confirmLabel: "Delete trip",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteTrip(id);
      await qc.invalidateQueries({ queryKey: ["mileage-summary"] });
      await qc.invalidateQueries({ queryKey: ["mileage-trips"] });
      toast.success(
        "Trip deleted. Rebuild your books to update the deduction.",
      );
    } catch (err) {
      toastError(err, "Couldn't delete the trip.");
    }
  }

  async function setMethod(next: "standard" | "actual") {
    if (!user) return;
    try {
      await saveVehicleYear(user.id, {
        tax_year: year,
        method: next,
        total_miles: vehicleYear?.total_miles ?? null,
        commuting_miles: vehicleYear?.commuting_miles ?? null,
        other_personal_miles: vehicleYear?.other_personal_miles ?? null,
        placed_in_service_on: vehicleYear?.placed_in_service_on ?? null,
      });
      await qc.invalidateQueries({ queryKey: ["vehicle-year"] });
      toast.success("Saved.");
    } catch (err) {
      toastError(err, "Couldn't save that.");
    }
  }

  function exportCsv() {
    if (!summary) return;
    const lines: string[] = [];
    lines.push(`MILEAGE LOG ${year}`);
    lines.push(
      `Method,${method === "standard" ? "Standard mileage rate" : "Actual expenses"}`,
    );
    lines.push("");
    lines.push("Date,Miles,Purpose,From,To,Round trip");
    for (const t of [...trips].reverse()) {
      lines.push(
        [
          t.trip_date,
          String(t.miles),
          escapeCsvCell(t.purpose),
          escapeCsvCell(t.start_location ?? ""),
          escapeCsvCell(t.end_location ?? ""),
          t.round_trip ? "yes" : "no",
        ].join(","),
      );
    }
    lines.push("");
    lines.push("TOTALS");
    lines.push(`Business miles,${summary.total_miles}`);
    lines.push(`Trips,${summary.trip_count}`);
    lines.push(`Deduction,${(summary.deduction_cents / 100).toFixed(2)}`);
    lines.push("");
    lines.push("SCHEDULE C PART IV");
    for (const r of partIvRows(summary, vehicleYear ?? null)) {
      lines.push(
        [
          r.line,
          escapeCsvCell(r.label),
          r.value === null ? "not answered" : String(r.value),
        ].join(","),
      );
    }
    if (warnings.length) {
      lines.push("");
      lines.push("BEFORE YOU FILE");
      for (const w of warnings) lines.push(escapeCsvCell(w.text));
    }
    lines.push("");
    lines.push(
      escapeCsvCell(
        "Standard mileage rate and actual vehicle expenses are alternatives, never both. GradeThread does the arithmetic. It does not give tax advice.",
      ),
    );
    downloadBlob(csvBlob(lines.join("\n")), `mileage-log-${year}.csv`);
  }

  const years = [0, 1, 2, 3].map((n) => new Date().getFullYear() - n);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Mileage</CardTitle>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            Every sourcing run is a deduction, but only if you wrote down the
            date, the miles and why you went.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select
            value={String(year)}
            onValueChange={(v) => setYear(Number(v))}
          >
            <SelectTrigger
              className="h-9 w-28"
              aria-label="Tax year for the mileage log"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Log a trip
          </Button>
          {summary && summary.trip_count > 0 && (
            <Button size="sm" variant="outline" onClick={exportCsv}>
              <FileSpreadsheet className="mr-2 h-4 w-4" />
              CSV
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* AC6. The election, stated where the number is, because it changes
            what the number means: standard rate and actual expenses are
            alternatives and a seller cannot claim both. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-muted-foreground">
            You are claiming
          </span>
          <Select
            value={method}
            onValueChange={(v) => setMethod(v as "standard" | "actual")}
          >
            <SelectTrigger
              className="h-8 w-56"
              aria-label="How vehicle costs are claimed"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">
                the standard mileage rate
              </SelectItem>
              <SelectItem value="actual">actual vehicle expenses</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-[13px] text-muted-foreground">for {year}.</span>
        </div>

        {method === "actual" ? (
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            On actual expenses you deduct petrol, insurance, repairs and
            depreciation instead of a rate per mile. Log your trips anyway: the
            business-use percentage still comes from the miles, and Part IV
            still asks for them. The figure below does not apply to you.
          </p>
        ) : isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : summary && summary.trip_count > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="text-2xl font-semibold tabular-nums">
              {formatCents(summary.deduction_cents)}
            </span>
            <span className="text-[13px] text-muted-foreground">
              {summary.total_miles} business miles across {summary.trip_count}{" "}
              trip{summary.trip_count === 1 ? "" : "s"}
            </span>
          </div>
        ) : null}

        {warnings.map((w) => (
          <p
            key={w.kind}
            className="flex max-w-prose gap-2 text-[13px] leading-relaxed text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {w.text}
          </p>
        ))}

        {summary && summary.trip_count === 0 ? (
          <EmptyState
            icon={Car}
            title={`No trips logged for ${year}`}
            description="A reseller sourcing twice a week drives thousands of miles a year. Logged at the time, that is a real deduction; reconstructed in April, it is the record the IRS discounts."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-2 text-left font-medium">Date</th>
                  <th className="p-2 text-right font-medium">Miles</th>
                  <th className="p-2 text-left font-medium">Purpose</th>
                  <th className="hidden p-2 text-left font-medium sm:table-cell">
                    Where
                  </th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {trips.map((t) => (
                  <tr key={t.id} className="border-b last:border-b-0">
                    <td className="p-2 whitespace-nowrap">{t.trip_date}</td>
                    <td className="p-2 text-right tabular-nums">{t.miles}</td>
                    <td className="p-2">
                      {t.purpose}
                      {t.round_trip && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          round trip
                        </span>
                      )}
                    </td>
                    <td className="hidden p-2 text-muted-foreground sm:table-cell">
                      {[t.start_location, t.end_location]
                        .filter(Boolean)
                        .join(" to ") || "—"}
                    </td>
                    <td className="p-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit the ${t.miles} mile trip on ${t.trip_date}`}
                        onClick={() => {
                          setEditing(t);
                          setDialogOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove(t.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Schedule C Part IV. Business miles come from the log; the other three
            cannot be derived from it, so a blank stays a blank. */}
        <PartIvSection
          year={year}
          summary={summary}
          vehicleYear={vehicleYear ?? null}
          conflict={conflict}
        />

        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          The rate comes from the date of each trip, so a year that changed
          rates part-way through is handled and last year's trips never reprice.
          GradeThread does the arithmetic. It does not give tax advice.
        </p>
      </CardContent>

      <TripDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        year={year}
      />
    </Card>
  );
}

function PartIvSection({
  year,
  summary,
  vehicleYear,
  conflict,
}: {
  year: number;
  summary: ReturnType<typeof mileageWarnings> extends never
    ? never
    : Parameters<typeof partIvRows>[0] | undefined;
  vehicleYear: Parameters<typeof partIvRows>[1];
  conflict: string | null;
}) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [total, setTotal] = useState("");
  const [commuting, setCommuting] = useState("");
  const [personal, setPersonal] = useState("");
  const [open, setOpen] = useState(false);

  if (!summary) return null;
  const rows = partIvRows(summary, vehicleYear);

  async function save() {
    if (!user) return;
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    try {
      await saveVehicleYear(user.id, {
        tax_year: year,
        method: vehicleYear?.method ?? "standard",
        total_miles: num(total),
        commuting_miles: num(commuting),
        other_personal_miles: num(personal),
        placed_in_service_on: vehicleYear?.placed_in_service_on ?? null,
      });
      await qc.invalidateQueries({ queryKey: ["vehicle-year"] });
      setOpen(false);
      toast.success("Saved.");
    } catch (err) {
      toastError(err, "Couldn't save those.");
    }
  }

  return (
    <div className="border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">What Schedule C Part IV asks</p>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            Only you know how far you drove in total. We will not guess these.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setTotal(vehicleYear?.total_miles?.toString() ?? "");
            setCommuting(vehicleYear?.commuting_miles?.toString() ?? "");
            setPersonal(vehicleYear?.other_personal_miles?.toString() ?? "");
            setOpen(true);
          }}
        >
          Answer these
        </Button>
      </div>

      <table className="mt-3 w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b last:border-b-0">
              <td className="w-12 py-2 text-xs text-muted-foreground">
                {r.line}
              </td>
              <td className="py-2">
                {r.label}
                {r.derived && (
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    from your log
                  </span>
                )}
              </td>
              <td className="py-2 text-right tabular-nums">
                {r.value === null ? (
                  <span className="text-[13px] text-amber-700 dark:text-amber-400">
                    not answered
                  </span>
                ) : (
                  r.value
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {conflict && (
        <p className="mt-3 flex max-w-prose gap-2 text-[13px] leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {conflict}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your driving in {year}</DialogTitle>
            <DialogDescription>
              Rough figures are fine, but they should be honest and consistent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="mv-total">Total miles you drove this year</Label>
              <Input
                id="mv-total"
                inputMode="decimal"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mv-commute">Commuting miles</Label>
              <Input
                id="mv-commute"
                inputMode="decimal"
                value={commuting}
                onChange={(e) => setCommuting(e.target.value)}
              />
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Driving to a regular job. Never deductible, and the form asks
                anyway.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mv-personal">Other personal miles</Label>
              <Input
                id="mv-personal"
                inputMode="decimal"
                value={personal}
                onChange={(e) => setPersonal(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TripDialog({
  open,
  onOpenChange,
  editing,
  year,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: MileageTrip | null;
  year: number;
}) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [date, setDate] = useState(() => ymd(new Date()));
  const [miles, setMiles] = useState("");
  const [purpose, setPurpose] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [roundTrip, setRoundTrip] = useState(true);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  // AC3: the places a seller actually goes, so the destination is a pick rather
  // than a retype. The full offer-at-the-moment flow on the sourcing screen is
  // where US-3000 hooks in on mobile; this is the prefill it will reuse.
  const { data: sources = [] } = useQuery({
    queryKey: ["mileage-sources", user?.id],
    enabled: !!user && open,
    queryFn: async (): Promise<SourceOption[]> => {
      const { data, error } = await supabase
        .from("sources")
        .select("id, name, location")
        .is("archived_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as SourceOption[];
    },
  });

  const seedKey = editing?.id ?? `new-${year}`;
  if (open && seeded !== seedKey) {
    setSeeded(seedKey);
    setDate(editing?.trip_date ?? ymd(new Date()));
    setMiles(editing ? String(editing.miles) : "");
    setPurpose(editing?.purpose ?? "");
    setStart(editing?.start_location ?? "");
    setEnd(editing?.end_location ?? "");
    setRoundTrip(editing?.round_trip ?? true);
    setSourceId(editing?.source_id ?? null);
  }
  if (!open && seeded !== null) setSeeded(null);

  // The rate that will actually be applied, shown before the seller saves, so
  // a date outside our table is visible immediately rather than as a silent
  // zero on the total afterwards.
  const { data: rate } = useQuery({
    queryKey: ["mileage-rate", date],
    enabled: open && !!date,
    queryFn: () => fetchRateOn(date),
  });

  const milesNum = Number(miles);
  const valid = date && milesNum > 0 && purpose.trim() !== "";

  async function save() {
    if (!user || !valid) return;
    setSaving(true);
    try {
      await saveTrip(user.id, {
        ...(editing ? { id: editing.id } : {}),
        trip_date: date,
        miles: milesNum,
        purpose: purpose.trim(),
        start_location: start.trim() || null,
        end_location: end.trim() || null,
        round_trip: roundTrip,
        source_id: sourceId,
        inventory_item_id: null,
      });
      await qc.invalidateQueries({ queryKey: ["mileage-summary"] });
      await qc.invalidateQueries({ queryKey: ["mileage-trips"] });
      toast.success(
        editing
          ? "Trip updated. Rebuild your books to update the deduction."
          : "Trip logged. Rebuild your books to update the deduction.",
      );
      onOpenChange(false);
    } catch (err) {
      toastError(err, "Couldn't save the trip.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit trip" : "Log a trip"}</DialogTitle>
          <DialogDescription>
            Date, miles and why you went. Those three are what makes it a
            record.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="tr-date">Date</Label>
              <Input
                id="tr-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tr-miles">Miles</Label>
              <Input
                id="tr-miles"
                inputMode="decimal"
                placeholder="0.0"
                value={miles}
                onChange={(e) => setMiles(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          {date && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {rate ? (
                <>
                  {formatRate(rate.tenths_of_cent_per_mile)}
                  {milesNum > 0 && (
                    <>
                      {" "}
                      &middot;{" "}
                      {formatCents(
                        Math.round(
                          (milesNum * rate.tenths_of_cent_per_mile) / 10,
                        ),
                      )}
                    </>
                  )}
                  {rate.is_provisional && (
                    <span className="text-amber-700 dark:text-amber-400">
                      {" "}
                      &middot; provisional rate, check before filing
                    </span>
                  )}
                </>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">
                  We have no rate for that date, so this trip will deduct
                  nothing until one is added.
                </span>
              )}
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="tr-purpose">Why you went</Label>
            <Input
              id="tr-purpose"
              placeholder="Sourcing run, post office, estate sale"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>

          {sources.length > 0 && (
            <div className="space-y-1">
              <Label htmlFor="tr-source">Which place</Label>
              <Select
                value={sourceId ?? "none"}
                onValueChange={(v) => {
                  if (v === "none") {
                    setSourceId(null);
                    return;
                  }
                  setSourceId(v);
                  const s = sources.find((x) => x.id === v);
                  // Prefill rather than overwrite: a seller who already typed a
                  // destination meant it.
                  if (s && !end.trim()) setEnd(s.location || s.name);
                  if (s && !purpose.trim()) setPurpose(`Sourcing at ${s.name}`);
                }}
              >
                <SelectTrigger id="tr-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not one of my places</SelectItem>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="tr-start">From</Label>
              <Input
                id="tr-start"
                placeholder="Optional"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tr-end">To</Label>
              <Input
                id="tr-end"
                placeholder="Optional"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={roundTrip}
              onChange={(e) => setRoundTrip(e.target.checked)}
              className="h-4 w-4"
            />
            Round trip
            <span className="text-[13px] text-muted-foreground">
              (put the full there-and-back mileage above)
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving ? "Saving" : editing ? "Save trip" : "Log trip"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
