// Adding months to a date, the way billing means it.
//
// `d.setMonth(d.getMonth() + 1)` does not add a month. It adds one to the month
// number and then lets the day overflow into the next month, so the last three
// days of January become the first three days of March. JavaScript has done
// this since 1995 and it looks correct in every test written on the 15th.
//
// Three places in this service got it wrong, and each one showed the seller
// something different:
//
//   payments.ts     pausing a subscription on 31 January for "1 month" set the
//                   resume date to 3 March. The seller was told the wrong date
//                   and billing stayed off for three extra days.
//   webhooks.ts     a subscriber whose renewal falls on the 31st had their
//                   included-grade counter reset scheduled three days late, so
//                   they sat at their cap after paying for a new period.
//   grade-billing   the free-tier reset is "the 1st of next month", computed as
//                   +1 month then setDate(1). Run on 31 January that is 3 March
//                   clamped to 1 March — a whole month late. Anyone whose first
//                   visit of the cycle fell on the 29th to 31st waited an extra
//                   month for their included grades.
//
// The right answer is to clamp the day to the target month's last day, which is
// what Stripe, every calendar app and every human means by "a month from the
// 31st". 31 January plus one month is 28 February, or 29 in a leap year.

/**
 * `from` advanced by `months`, with the day clamped to the target month's last
 * day rather than allowed to spill into the month after.
 *
 * Negative `months` works the same way. The time of day is untouched.
 *
 * Local-time fields on purpose: it replaces `setMonth`/`getMonth` call sites and
 * changes only the overflow, never the timezone they were already reading.
 */
export function addMonthsClamped(from: Date, months: number): Date {
  const year = from.getFullYear();
  const month = from.getMonth();
  const day = from.getDate();

  const shifted = month + months;
  const targetYear = year + Math.floor(shifted / 12);
  const targetMonth = ((shifted % 12) + 12) % 12;

  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();

  const out = new Date(from.getTime());
  // Set all three together. Setting them one at a time reintroduces exactly the
  // overflow this exists to prevent, on the intermediate value.
  out.setFullYear(targetYear, targetMonth, Math.min(day, lastDay));
  return out;
}

/** Midnight on the first day of the month after `from`. */
export function startOfNextMonth(from: Date): Date {
  const out = new Date(from.getFullYear(), from.getMonth() + 1, 1);
  out.setHours(0, 0, 0, 0);
  return out;
}
