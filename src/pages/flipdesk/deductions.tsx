import { Car } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { MileageLogCard } from "@/components/finances/mileage-log-card";
import { HomeOfficeCard } from "@/components/finances/home-office-card";

// US-2999 — the two deductions that accumulate all year and get claimed by
// nobody.
//
// THEY WERE ON THE TAX PAGE, under eight other cards, which is the wrong shape
// for what they are. Everything else on that page is something you do in March;
// mileage is something you record the day you drive, and both are worth real
// money to a reseller who has never claimed either. Buried at position six and
// seven they were effectively invisible.
//
// Both are CALENDAR-year surfaces, deliberately: mileage rates are published
// per calendar year and the Schedule C Part IV questions are asked per calendar
// year, so a fiscal-year selector here would be actively wrong. That is why
// they sit together rather than under the P&L, which follows the seller's
// fiscal year.

export function DeductionsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Car}
        title="Deductions"
        subtitle="Two things you are entitled to claim that never show up as a receipt."
      />

      <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
        These are worked out on your return rather than booked as expenses, so
        they do not appear in your P&amp;L or push to QuickBooks. They land on
        your year-end packet.
      </p>

      <MileageLogCard />

      <HomeOfficeCard />
    </div>
  );
}
