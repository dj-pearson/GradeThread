// US-2667: the crisis path for the AI Support Assistant.
//
// WHY THIS EXISTS. The assistant's system prompt (support-assistant-engine.ts)
// classifies everything outside grading/FlipDesk/billing as OUT OF SCOPE and
// answers it with "a brief, friendly refusal" plus an offer to escalate. That
// is the right behaviour for tax advice and for coding help. It is the wrong
// behaviour, in the most serious way available, for someone typing that they
// want to hurt themselves. The refusal is polite, immediate, and reads as a
// door closing.
//
// So the crisis turn never reaches the model at all. Detection is deterministic
// and runs on the user's text before a token is spent; the reply is a FIXED
// string, not something generated. Three reasons for that, in order:
//
//   1. A generated reply can be wrong once. A constant cannot.
//   2. It cannot be steered. Nothing a user pastes changes what comes back.
//   3. It costs nothing, so it can run before the rate-limit and lockout gates
//      the abuse controls apply. Someone in crisis who has tripped a flood
//      limit still gets the numbers.
//
// WHICH WAY THIS FAILS, deliberately: toward showing the resources. A false
// positive costs one person a message they did not need and one operator a
// glance at a thread. A false negative costs something we cannot repair. The
// negative cases pinned in the tests are the ones this product actually
// produces ("kill this listing", "this reconciliation is killing me"), not a
// general attempt to be clever about intent.
//
// NOT A CLINICAL TOOL. This is a routing decision plus a set of phone numbers.
// It does not assess risk, it does not counsel, and it says so to the user.
//
// KNOWN LIMIT, stated rather than discovered later: the matching is English and
// Latin-script only. normalizeForCrisis() folds everything that is not a-z into
// a space, so a message written in Spanish or in Cyrillic cannot match any
// pattern here and takes the ordinary model path. That is a real gap, and it is
// the one to close first if the product ever ships a second language.

// ── The reply ────────────────────────────────────────────────────────────────
//
// Written to do four things and nothing else: say a person matters more than
// the ticket, be honest that this is a bot, give resources that work now, and
// name what happens next. No product talk. No "is there anything else".
//
// US resources first because that is where the customer base is, then a global
// directory so a non-US user is not handed a number they cannot dial. The
// emergency line is last on purpose: leading with "call 911" reads as being
// handed off rather than heard.
export const CRISIS_RESPONSE =
  "I'm reading something in your message that matters a lot more than anything " +
  "to do with your account, and I want to stop and say so.\n\n" +
  "I'm an automated assistant for a clothing-grading app, so I'm not the right " +
  "help here, and I don't want to pretend otherwise. Please reach someone who " +
  "is:\n\n" +
  "- In the US: call or text 988 (Suicide & Crisis Lifeline), any time, free.\n" +
  "- In the US: text HOME to 741741 to reach the Crisis Text Line.\n" +
  "- Anywhere else: findahelpline.com lists free crisis lines by country.\n" +
  "- If you are in immediate danger, please call your local emergency number.\n\n" +
  "I've also flagged this conversation to a person on our team. You don't have " +
  "to reply here, and nothing about your account needs your attention right " +
  "now.";

// The reason stored on support_conversations.escalation_reason and shown in the
// admin inbox. Deliberately free of the user's own words: an operator needs to
// know WHY the thread is urgent, and the message itself is one click away in
// the thread. Copying distressed text into a list view, a notification body and
// an email subject line is three more places it can be read by someone who did
// not need to.
export const CRISIS_ESCALATION_REASON =
  "Possible crisis / self-harm language detected. Please review this thread first.";

export const CRISIS_ESCALATION_SUMMARY =
  "The assistant matched crisis language on the user's message, replied with " +
  "crisis resources instead of a scope refusal, and handed the thread to a " +
  "human. The message itself is in the conversation.";

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Fold a message into a comparable form: lowercase, and every run of non-letter
 * characters becomes a single space. Apostrophes SURVIVE, because "don't want
 * to live" is a phrase the patterns below match literally, and flattening the
 * apostrophe into a space would break it.
 *
 * The flattening is what makes "kill-myself", "kill.myself" and "kill   myself"
 * all read as "kill myself" without a pattern for each.
 */
export function normalizeForCrisis(message: string): string {
  return message
    .toLowerCase()
    // DELIBERATE non-ASCII, and the one place in this file it is load-bearing:
    // these are the curly apostrophes a phone keyboard produces. They fold to
    // the straight one FIRST, because the next step would otherwise eat them and
    // turn "don<curly>t want to live" into "don t want to live", which matches
    // nothing. Written as literals because that is what arrives in the message.
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Phrases that contain a self-directed verb and mean something ordinary. They
// are DELETED from the text before the patterns run, rather than short-circuiting
// the whole message. The difference is not cosmetic: a message reading "I cut
// myself off from sourcing and honestly I want to die" must still be a crisis,
// and an override that returned early on the first half would have swallowed the
// second. Kept short on purpose - every entry here is a hole.
const BENIGN_OVERRIDES: readonly RegExp[] = [
  // "I had to cut myself off from sourcing this month" - a budget sentence.
  /\bcut myself off\b/g,
];

// Ordered so the most explicit patterns sit at the top; the matched pattern's
// index is not used for anything, but reading order matters to the next person.
const CRISIS_PATTERNS: readonly RegExp[] = [
  /\bsuicid(e|al)\b/,
  // The self-directed verbs. "myself" is doing the whole job of separating
  // "kill myself" from "kill this listing", which is why the negative cases in
  // the test are all of the second shape.
  // "cut" is spelled out separately because its participle DOUBLES the final
  // consonant - "cutting". A shared (ing|s)? suffix covers killing, hurting and
  // hanging and silently misses the one form most likely to be typed here.
  /\b((kill|hurt|harm|end|hang|shoot|drown)(ing|s)?|cut(ting|s)?) myself\b/,
  /\bself harm(ing|ed)?\b/,
  /\b(end|ending|take|taking) my (own )?life\b/,
  // "wanna" already contains the "to", so it cannot share the branch with
  // "want to" - requiring both swallowed "i wanna die" entirely.
  /\b((want|wants|wanted|need|needs) to|wanna) die\b/,
  /\bdon't want to (live|be here|exist|wake up|be alive|go on)\b/,
  /\bno (reason|point) (to|in) (live|living|be here|going on)\b/,
  /\b(better|best) off (dead|without me)\b/,
  /\bend it all\b/,
  /\bnot worth living\b/,
  /\b(going to|gonna) overdose\b/,
  /\btake all (my|the) pills\b/,
];

export interface CrisisDetection {
  /** True when the turn must take the crisis path instead of the model. */
  crisis: boolean;
  /**
   * The pattern source that matched, for tests and for the ops log. NEVER the
   * user's text: this value travels into logs and analytics, and the message
   * itself belongs only in the conversation.
   */
  pattern?: string;
}

const NO_CRISIS: CrisisDetection = { crisis: false };

/**
 * Deterministic crisis check on a single user turn.
 *
 * Pure: no model, no network, no clock. The route calls it before the abuse
 * controls and before any token is spent.
 */
export function detectCrisis(message: string): CrisisDetection {
  if (!message) return NO_CRISIS;
  let text = normalizeForCrisis(message);
  if (!text) return NO_CRISIS;

  for (const benign of BENIGN_OVERRIDES) {
    text = text.replace(benign, " ");
  }
  for (const pattern of CRISIS_PATTERNS) {
    if (pattern.test(text)) return { crisis: true, pattern: pattern.source };
  }
  return NO_CRISIS;
}
