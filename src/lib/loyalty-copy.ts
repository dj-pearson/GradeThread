// US-1914 AC4: the fence around how GradeThread talks to someone who was away.
//
// The rule is short: a returning user is welcomed, never shamed. Seller standing
// does not decay — level, badges, tenure and integrity are all monotonic — so
// any copy implying a loss is not merely unkind, it is FALSE. And "don't write
// that" is a rule that lives in a story nobody reads twice, which is why it
// lives here as data instead, with a guard test that finds the surfaces by
// discovery rather than by a list someone has to remember to extend.
//
// Why this is a real risk rather than a hypothetical: the entire idiom of
// retention copy is loss aversion. "Don't lose your streak", "you're falling
// behind", "your progress expires in 3 days" are the first sentences any
// engagement feature reaches for, they measurably work in the short term, and
// they are precisely wrong for a reseller whose business is bursty by nature.
// The customer this platform most wants to keep — the one who sources for three
// weeks and lists forty items in a weekend — is the one that copy punishes.
//
// Buyer confirmation streaks DO exist (they have a genuinely weekly rhythm, plus
// grace and freezes), so words like "streak" and "chain" are not banned. What is
// refused is the LOSS FRAME: telling anyone they lost, broke, forfeited or are
// about to forfeit standing.

/**
 * Phrases no user-facing surface may contain, in any client.
 *
 * Matched case-insensitively against normalized text (whitespace collapsed), so
 * a phrase broken across two lines of JSX is still caught. Kept as whole phrases
 * rather than single words on purpose: banning "lost" alone would trip on "lost
 * package", which is a real thing a shipping surface has to be able to say.
 */
export const REFUSED_LOSS_PHRASES: readonly string[] = [
  "lost your streak",
  "you lost your",
  "streak lost",
  "lost your progress",
  "lost your standing",
  "lost your level",
  "broken streak",
  "streak broken",
  "you broke your",
  "don't lose your streak",
  "dont lose your streak",
  "before you lose",
  "you're falling behind",
  "youre falling behind",
  "you have fallen behind",
  "you've fallen behind",
  "youve fallen behind",
  "you're slipping",
  "youre slipping",
  "we miss you",
  "where have you been",
  "your progress expires",
  "your standing expires",
  "your level expires",
  "your rewards expire if",
  "start over from",
  "back to square one",
];

/**
 * The promise the loyalty surfaces make, stated once so every client says the
 * same thing. A returning user reads this, not a countdown.
 */
export const STANDING_PRESERVED_COPY =
  "Your level, badges and member-since standing are exactly where you left them, and they stay that way.";

/** The one-line explanation of what tenure is, for the flair's tooltip/blurb. */
export const TENURE_EXPLAINER_COPY =
  "Tenure counts how long you've been a member. It only ever goes up — a quiet month costs you nothing.";

/**
 * "Member since March 2024". Pure.
 *
 * Month precision rather than a full date: the exact day is an account detail,
 * the month is the flair. An unparseable value returns null so the caller
 * renders nothing — a "Member since Invalid Date" chip is worse than no chip.
 */
export function memberSinceLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * "3 years", "18 months", "2 months". Pure.
 *
 * Years once there is at least one, because "37 months" is a number nobody
 * carries around about themselves. Below a year it stays in months so a new
 * member's first milestones still read as progress.
 */
export function tenureLengthLabel(months: number): string {
  const m = Math.max(0, Math.floor(months));
  if (m < 1) return "less than a month";
  if (m < 12) return `${m} month${m === 1 ? "" : "s"}`;
  const years = Math.floor(m / 12);
  return `${years} year${years === 1 ? "" : "s"}`;
}
