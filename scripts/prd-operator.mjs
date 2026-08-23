#!/usr/bin/env node
// prd-operator — what the OWNER has to do, pulled out of the backlog.
//
// WHY THIS EXISTS. Roughly half the open stories carry work no agent and no CI
// lane can do: rotate a key, approve a scope, click through a live sell form,
// run a query against prod. Each one is recorded honestly, and each one is
// recorded in a different place — halfway through a 4000-character note, in a
// title prefix, in an acceptance criterion. So the queue was real and
// unreadable, and the same stories kept getting re-opened, re-read and
// re-deferred.
//
// THE FLOOR CAVEAT AT THE BOTTOM OF THIS FILE IS NOT DECORATION, and the way it
// was checked on 2026-08-15 is worth more than the numbers. Scanning the same
// notes with a wider signal set took the queue from 37 to 49, then to 52. After
// the second round a scan reported ZERO remaining and I said so.
//
// That was wrong. US-2444 was sitting there saying "STILL OPEN AND ALL OWNER
// WORK" — a phrasing no candidate in that round happened to include. The
// mistake was the method, not the list: a hand-picked phrase list can only find
// phrasings someone already thought of, so reporting zero from one is a
// statement about the list rather than about the backlog.
//
// Hence `--audit`, which stops guessing and returns a READING LIST instead. It
// is over-wide by design and mostly false positives. Trust the DECLARED section;
// treat the total as a floor no matter how many rounds of tuning it has had.
//
// TWO SECTIONS, AND THE SPLIT IS THE POINT.
//
//   DECLARED   — an acceptance criterion that starts with `OPERATOR:`. Exact,
//                machine-readable, quoted verbatim. This is the convention;
//                write new operator work this way.
//   UNDECLARED — the note says somewhere that a human is needed, but the story
//                never says so structurally. The matched sentence is extracted
//                as EVIDENCE, not as an instruction: prose is not a contract,
//                and an extract can lose the qualifier that made it true.
//
// Reporting them merged would be the dishonest version — it would give a
// hand-pulled sentence the same authority as a declared criterion. Read the
// story before acting on anything in the second list.
//
// This is a REPORT, not a gate. It always exits 0. Nothing here should be able
// to fail a build: a backlog that has not adopted a convention yet is not a
// regression.
//
//   node scripts/prd-operator.mjs [--declared] [--json] [--all] [--sessions]
//
// --sessions groups the queue by the KIND of access each item needs, because
// "what can I clear in one sitting" is a different question from "what is most
// worth doing", and it is the one that governs throughput.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comparePriority } from "./lib/prd-priority.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** An acceptance criterion is DECLARED operator work if it opens with the tag. */
// Bracketed form needs no separator ("[OPERATOR] apply 00589"); the bare word
// does ("OPERATOR: …"), or every criterion that happens to open with the word
// would qualify.
export const DECLARED_RE = /^\s*(?:\[(?:OPERATOR|OWNER|HUMAN)\]|(?:OPERATOR|OWNER|HUMAN)\s*[:\-])\s*/i;

/**
 * Patterns that mean "a person has to do THIS STORY's remaining work".
 *
 * Every one is anchored to a predicate, not to the bare word. That is not
 * fussiness — the first draft used plain substrings and immediately matched
 * prose ABOUT operators rather than work FOR one: `operator read` matched "an
 * operator reading that at 3am", and `operator-only` matched a visibility flag
 * described as "customer-readable vs operator-only". Both are stories with real
 * operator work, and both got quoted the wrong sentence, which is the same
 * failure as being wrong. A queue that cries wolf gets ignored, which is the
 * exact problem this script exists to fix.
 *
 * Ordered strongest first: the first match wins the quote.
 */
export const UNDECLARED_PATTERNS = [
  /REMAINING FOR THE OWNER/,
  /USER ACTION REQUIRED/,
  /\bis (?:an |a )?(?:genuinely )?operator (?:action|task|read|work)\b/i,
  /\b(?:are|is) (?:genuinely )?operator work\b/i,
  /\bis operator-only\b/i,
  /\bAC\d\b[^.]{0,40}\boperator[- ](?:only|action|work)\b/i,
  /\bis a human action\b/i,
  /\bneeds a logged-in human\b/i,
  /\bcannot be done from here\b/i,
  /\bnot automatable from this host\b/i,
  // Added after measuring the gap this file's own closing caveat predicted.
  // The first pattern set was tuned against stories that used the word
  // "operator", and it found 6 undeclared. A wider scan of the same notes found
  // 14 — eight stories saying a person is needed in words the queue could not
  // see, including three at priority 25. Each pattern below is still anchored to
  // a predicate, and each was checked against every quote it pulls.
  /\bthis host cannot run\b/i,
  /\bcannot be (?:done|run|verified|proven|answered) from (?:here|this host)\b/i,
  /\bnot agent work\b/i,
  /\bneeds a prod (?:query|read|session)\b/i,
  /\bneeds a partner answer\b/i,
  // "a human with the product open", "a human with the Stripe Dashboard".
  //
  // The trailing "the" was dropped on 2026-08-22: US-2702 says "a human with
  // logged-in Grailed and Vinted accounts" and did not match. Same failure as
  // the adjective one below — a pattern anchored one word too tightly, invisible
  // because the phrase reads as though it obviously matches.
  /\ba human with\b/i,
  // "STILL OPEN, and it is one human sitting: log in to Poshmark" (US-2698).
  /\bone human\b/i,
  /\bis a Stripe (?:D|d)ashboard(?:\/API)? setting\b/i,
  // Third measurement, same day: after the seven above, exactly two stories were
  // still invisible and both used this one phrase. Eleven other candidate
  // phrasings ("only you can", "cannot be automated", "waiting on the owner")
  // matched NOTHING in the current backlog — so the floor is now close to the
  // census, and adding more speculative patterns would be tuning against
  // sentences nobody has written.
  /\bBLOCKED ON A HUMAN\b/i,

  // ── Fourth measurement, 2026-08-22, and it corrects the paragraph above ──
  //
  // "Close to the census" was wrong. Six open stories were describing operator
  // work in prose; these patterns saw two of them. The four misses were
  // US-2738 (priority 8), US-2739 (priority 8), US-2700 and US-1968 — two of
  // them the top-priority non-operator stories in the whole backlog, both
  // sitting there looking like code work while their last item needed a
  // browser and a logged-in account.
  //
  // The claim that survived longest here is the one worth retiring: that the
  // remaining phrasings are speculative. They are not written speculatively.
  // Every pattern below was READ OFF a sentence already in this backlog, the
  // same standard the seven above were held to — the difference is only that
  // nobody had gone looking a fourth time.
  //
  // "the only remaining item ... needs a live seller account" (US-1968),
  // "it needs a live logged-in account" (US-2700),
  // "it needs a live Poshmark form" (US-2739).
  /\bneeds? a live\b/i,
  // "nobody has put this in front of a live Poshmark form" (US-2738).
  /\bin front of a live\b/i,
  // "Nothing in the code can answer that" (US-2739 AC11) — a different
  // predicate from the "cannot be done from here" family above, which is about
  // the HOST. This one is about the code itself, and it read as a limitation
  // rather than as a request, which is why it went unactioned.
  /\bnothing (?:in the code|here|we can write) can answer\b/i,

  // ── Fifth measurement, same day, and it is the cheapest lesson of the five ──
  //
  // US-1882 AC4 says "needs a real browser on a real marketplace" and was
  // invisible to every pattern above. The reason is one word: each noun pattern
  // required its noun to follow "a" IMMEDIATELY, so a single adjective defeated
  // all of them at once.
  //
  // That is the kind of gap that survives longest, because the phrase reads as
  // though it obviously matches — you do not re-check a pattern you are sure of.
  // Both of the previous two rounds were found the same way: by testing the
  // detector against a story whose answer was already known, never by re-reading
  // the regexes.
  /\bneeds? an? (?:\w+\s+)?(?:device|phone|emulator|browser|marketplace|account|login)\b/i,
];

/** Sentence around `idx`, trimmed to something a terminal line can hold. */
export function extractSentence(text, idx, max = 260) {
  const before = text.lastIndexOf(". ", idx);
  const segment = text.lastIndexOf(" | ", idx);
  const start = Math.max(before === -1 ? 0 : before + 2, segment === -1 ? 0 : segment + 3);
  let end = text.indexOf(". ", idx);
  if (end === -1) end = text.length;
  const raw = text.slice(start, Math.min(end + 1, start + max * 2)).trim();
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/**
 * Words that, in a story's LAST note segment, mean it is worth READING to see
 * whether a person is needed. Deliberately dumb and over-wide.
 *
 * This exists because guessing phrases kept under-reporting, twice. The
 * patterns above were extended to match "a PROD query this host cannot run" and
 * "BLOCKED ON A HUMAN", the scan then reported zero remaining — and US-2444 was
 * sitting there saying "STILL OPEN AND ALL OWNER WORK", which no candidate
 * phrase in that round happened to include. The lesson is about the METHOD: a
 * hand-picked phrase list can only find phrasings someone already thought of,
 * and reporting zero from one is a statement about the list.
 *
 * So {@link auditCandidates} does not classify. It returns stories to read, and
 * the count is expected to be large and mostly false positives. That is the
 * correct shape: one line of reading versus a story nobody ever does.
 */
const AUDIT_WIDE =
  /\b(owner|operator|human|prod|production|paste|dashboard|console|manual|by hand|autonomous|autonomously|live-site|counsel|sourcing)\b/i;

/**
 * Open, non-queued stories whose last note segment mentions anything that could
 * mean a person. NOT a finding — a reading list. Behind `--audit` so the default
 * report keeps its precision.
 */
/**
 * A segment that says outright what is still not done. Uppercase-anchored the
 * way this backlog actually writes them.
 */
const OPEN_CLAIM =
  /\b(STILL BLOCKS|STILL OPEN|NOT DONE|REMAINS?\b|REMAINING|OUTSTANDING|BLOCKS passes|cannot be done autonomously)\b/;

/**
 * Segments worth reading for "is a person needed": the LAST one, plus any
 * earlier one that made an explicit open-work claim.
 *
 * READING ONLY THE LAST SEGMENT WAS WRONG, and US-1880 is why. Its remaining
 * work — live-site QA of five marketplace adapters, which no agent can do — is
 * stated in a segment from 2026-07-18. Three LATER segments are all corrections
 * about a migration's held status, so the last segment is about something else
 * entirely and the story read as unblocked.
 *
 * Notes are append-only, so position is meaningful, but "latest" is not the same
 * as "current": a correction appended about one topic does not supersede an open
 * claim about another. So an earlier claim counts unless a later segment closes
 * it — the same segment-order resolution prd-lint's findUnresolvedDeferrals and
 * its held-migration check already use, and for the same reason.
 */
function segmentsWorthReading(notes) {
  const segments = notes.split(" | ");
  const last = segments.length - 1;
  const picked = new Set([last]);
  for (let i = 0; i < last; i++) {
    if (!OPEN_CLAIM.test(segments[i])) continue;
    // Closed by anything after it that reads as a completion for this story.
    const closedLater = segments
      .slice(i + 1)
      .some((seg) => /\b(DONE|SHIPPED|RESOLVED|VERIFIED|CLOSED)\b/.test(seg));
    if (!closedLater) picked.add(i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => segments[i]);
}

export function auditCandidates(stories) {
  const { declared, undeclared } = collect(stories);
  const queued = new Set([...declared, ...undeclared].map((s) => s.id));
  const out = [];
  for (const s of stories) {
    if (s.passes || queued.has(s.id)) continue;
    const notes = String(s.notes ?? "");
    if (!notes) continue;
    const relevant = segmentsWorthReading(notes);
    const hit = relevant.find((seg) => AUDIT_WIDE.test(seg));
    if (!hit) continue;
    const sentences = hit.split(/(?<=[.!?])\s+/);
    const marker = sentences.find((t) =>
      /\b(remain|still open|STILL|OPEN AC|left|outstanding|not done|blocked)\b/i.test(t)
    );
    out.push({
      id: s.id,
      priority: s.priority,
      title: s.title,
      quote: (marker ?? sentences.at(-1) ?? "").trim(),
    });
  }
  out.sort(comparePriority);
  return out;
}

/**
 * How many OTHER open stories name this one.
 *
 * WHY THIS MATTERS MORE THAN PRIORITY HERE. The queue has been 70-odd items for
 * a while, and a flat list sorted by priority does not answer the question a
 * person actually has in front of it: which one of these, done first, stops
 * blocking the most other work. A story named by six others is usually a
 * measurement or a credential that six pieces of analysis are waiting on.
 *
 * Counted from the TEXT — description, notes and acceptance criteria — because
 * this backlog records dependencies in prose ("blocked on US-2001", "gated on
 * US-2403") rather than in a field. That is imprecise on purpose: a mention is
 * evidence of a relationship, not proof of one, so the output calls it
 * "named by" rather than "blocks".
 *
 * Self-references and mentions of CLOSED stories are ignored — the first is
 * noise and the second is history.
 */
export function namedByCount(stories) {
  const open = stories.filter((s) => !s.passes);
  const openIds = new Set(open.map((s) => s.id));
  const by = new Map();
  for (const s of open) {
    const text = [
      s.description ?? "",
      s.notes ?? "",
      ...(s.acceptanceCriteria ?? []),
    ].join(" ");
    for (const m of text.matchAll(/US-(\d{3,4})/g)) {
      const id = `US-${m[1]}`;
      if (id === s.id || !openIds.has(id)) continue;
      if (!by.has(id)) by.set(id, new Set());
      by.get(id).add(s.id);
    }
  }
  return by;
}

/**
 * An operator criterion that has been DONE, marked in the criterion itself.
 *
 * The queue is a list of things a person still has to do, and a list with
 * finished items on it stops being read — the same failure that let a red CI
 * lane sit for three weeks. Notes already record satisfaction, but the queue
 * reads CRITERIA, so a done step kept reappearing at the top under "START HERE"
 * with other stories named as waiting on it.
 *
 * Requires a DATE, so the marker carries evidence of when rather than just a
 * claim. Satisfied items are counted and reported, never silently dropped: an
 * item that vanishes is indistinguishable from one nobody ever wrote down.
 */
export const SATISFIED_RE = /\bSATISFIED\s+\d{4}-\d{2}-\d{2}\b/i;

export function collect(stories) {
  const open = stories.filter((s) => !s.passes);
  const declared = [];
  const undeclared = [];
  let satisfied = 0;

  for (const s of open) {
    const allDeclared = (s.acceptanceCriteria ?? []).filter((a) => DECLARED_RE.test(a));
    const acs = allDeclared.filter((a) => {
      if (!SATISFIED_RE.test(a)) return true;
      satisfied++;
      return false;
    });
    if (acs.length > 0) {
      declared.push({ id: s.id, priority: s.priority, title: s.title, items: acs });
      // A story that declares its operator work is NOT also listed as
      // undeclared, even when the note repeats it in prose. One row per story
      // in the queue, at the highest fidelity that story offers.
      continue;
    }
    // ⚠ A story whose declared work is ALL satisfied must not fall through to
    // the prose scanner. It would come straight back as an UNDECLARED row,
    // quoted from a note sentence — the same item under a weaker heading, which
    // is worse than leaving it declared: it loses the marker AND the evidence.
    // Caught by its own test case, which was written expecting this.
    if (allDeclared.length > 0) continue;
    const notes = s.notes ?? "";
    const titleTagged = /^\s*\[OPERATOR\]/i.test(s.title);
    const hits = [];
    for (const pattern of UNDECLARED_PATTERNS) {
      const m = pattern.exec(notes);
      if (m) hits.push(extractSentence(notes, m.index));
    }
    if (hits.length === 0 && !titleTagged) continue;
    undeclared.push({
      id: s.id,
      priority: s.priority,
      title: s.title,
      titleTagged,
      // Dedupe: two phrases often land in the same sentence.
      evidence: [...new Set(hits)],
    });
  }

  declared.sort(comparePriority);
  undeclared.sort(comparePriority);
  return { declared, undeclared, openCount: open.length, satisfied };
}

/**
 * What KIND of access an operator item needs.
 *
 * WHY GROUPING BEATS RANKING HERE. The queue already ranks by how many other
 * stories name each item, which answers "what is most worth doing". It does not
 * answer "what can I do in one sitting", and that is the question that actually
 * governs throughput: 82 items across 124 stories are not 82 separate errands.
 * They are a handful of SESSIONS — one read-only psql session answers a dozen,
 * one Coolify config pass answers another dozen, and one deploy window answers
 * the rest. Several notes say so in prose ("worth pairing with the other
 * deploy-blocked items when you next rebuild"), where nothing can act on it.
 *
 * ORDER IS PART OF THE ANSWER, not decoration. The deploy session must come
 * after the config session, because the settings only take effect on a rebuild;
 * and the verification session must come after the deploy, because a drill run
 * before it produces evidence tagged to a build nobody can identify.
 *
 * Classified by what the text SAYS it needs. An item matching nothing lands in
 * "unclassified" and is printed rather than dropped — a queue that silently
 * loses items is worse than one that admits it does not know.
 */
export const SESSION_KINDS = [
  {
    key: "thirdparty",
    title: "1. Third-party consoles and partner conversations",
    hint:
      "App Store Connect, Play Console, Stripe, Sentry, eBay/Etsy/Depop support. " +
      "Each is someone else's system and several have their own lead time.",
    match:
      /\b(app store connect|play console|stripe (dashboard|console|test mode)|(in|check|read|search) sentry|sentry (dashboard|search|routing|project)|apple (developer|support|id)|google play|partner|support ticket|ask (etsy|depop|whatnot)|web store|purchase history|restricted scopes?|apply to|approval|keystring|rotate the .* key)\b/i,
  },
  {
    key: "sql",
    title: "2. One read-only SQL session against production",
    hint:
      "scripts/prod-diagnostics-console.sql pastes into the Supabase SQL editor, " +
      "one section at a time. Nothing in it writes.",
    match:
      /\b(prod-diagnostics|SELECT\s|psql|query|queries|pg_proc|pg_constraint|audit prod|count\(\*\)|§\d+|section \d+|read-only)\b/i,
  },
  {
    key: "config",
    title: "3. One configuration pass (Coolify, Cloudflare, Supabase settings)",
    hint:
      "Values and toggles only. These take effect on the NEXT deploy, which is " +
      "why this session comes before the deploy one.",
    match:
      /\b(coolify|cloudflare|env var|environment variable|set [A-Z_]{4,}|GIT_SHA|SOURCE_COMMIT|build arg|dashboard|console|scale the edge|replica|gotrue|OTP TTL|in staging)\b/i,
  },
  {
    key: "deploy",
    title: "4. One deploy window, then verify during it",
    hint:
      "Everything that can only be observed on a rebuild. Time it: at least one " +
      "item wants an ACTIVE grading batch at the moment the deploy lands.",
    match:
      /\b(after (the next )?(edge )?deploy|redeploy|rebuild|deployment window|during (a|an active)|drill|health\/ready)\b/i,
  },
  {
    key: "command",
    title: "5. One command run, with production credentials in the environment",
    hint:
      "Scripts that already exist and just need to be pointed at prod. Each is " +
      "one line and several close a story outright.",
    match:
      /\b(npm run [a-z:]+|node scripts\/|deno run|RETENTION_DB_URL|scripts\/[a-z-]+\.(mjs|sh|ts))\b/i,
  },
  {
    key: "device",
    title: "6. Hands on a device or a real listing",
    hint:
      "A screen reader, a phone, a live marketplace listing. Nothing here can be " +
      "simulated from a checkout.",
    match:
      /\b(screen reader|NVDA|VoiceOver|real (multi-variation|listing|device|browser)|sandbox store|logged in|by hand|physically|installing the add-on|with the product open|a tape measure)\b/i,
  },
  {
    key: "counsel",
    title: "7. Counsel review — legal wording, not engineering",
    hint:
      "Terms, disclosures, claim substantiation. Every one of these stories says " +
      "in its own criteria that an agent must not draft the language, so they " +
      "cannot be closed by anyone here no matter how much code is done.",
    match:
      /\b(counsel|lawyer|legal (copy|review|language|wording)|substantiation|do not let an agent draft|not agent work)\b/i,
  },
  {
    key: "sourcing",
    title: "8. Sourcing — material that has to be created or licensed",
    hint:
      "Reference imagery, brand data, screenshots, golden-set labels. The " +
      "mechanism is built in every one of these; what is missing is the content, " +
      "and no amount of code produces it.",
    match:
      /\b(sourcing|source licensed|reference imagery|brand profiles do not exist|business action|needs a real image|with the product open|physical garments)\b/i,
  },
  {
    key: "host",
    title: "9. Root on the database/storage host",
    hint:
      "Actions on the Contabo box itself — disk encryption, cron installation, " +
      "moving a key off the machine it protects. Separate from the config pass " +
      "because these need shell access, not a dashboard.",
    match:
      /\b(full-disk encryption|host action|on the prod DB host|install the backup cron|off the DB host|rclone crypt)\b/i,
  },
];

/**
 * Bucket every queue item into the FIRST session kind whose pattern it matches.
 *
 * First-match rather than all-matches on purpose: an item that appears in three
 * sessions gets done three times or zero times. One home each, and the order of
 * SESSION_KINDS is the tie-break — which is why the sitting with the longest LEAD
 * TIME (partner approval — a request to somebody else) is first, and the
 * cheapest, most-unblocking one (read-only SQL) is second.
 */
export function groupBySession(declared, undeclared) {
  const rows = [
    ...declared.map((d) => ({ id: d.id, priority: d.priority, title: d.title, text: d.items.join(" ") })),
    ...undeclared.map((u) => ({ id: u.id, priority: u.priority, title: u.title, text: u.evidence.join(" ") })),
  ];
  // The TITLE is matched too, and it is not a nicety: the [OPERATOR]-prefixed
  // stories carry their whole instruction in the title and have no evidence text
  // at all, so the matcher previously had nothing to read and dropped four
  // partner-approval items into "unclassified".
  for (const r of rows) r.text = `${r.title} ${r.text}`.trim();
  const out = new Map(SESSION_KINDS.map((k) => [k.key, []]));
  out.set("unclassified", []);
  for (const r of rows) {
    const kind = SESSION_KINDS.find((k) => k.match.test(r.text));
    out.get(kind ? kind.key : "unclassified").push(r);
  }
  for (const list of out.values()) list.sort(comparePriority);
  return out;
}

function rank(s) {
  return s.priority === undefined || s.priority === null ? "  -" : String(s.priority).padStart(3);
}

/**
 * Every backlog file, not just prd.json.
 *
 * ⚠ THIS READ ONE FILE AND FOUR OPEN STORIES WERE INVISIBLE (2026-08-22).
 * `prd-seo.json` and `prd-connector.json` are siblings holding their own
 * programmes, and nothing in this queue looked at them — so US-9017's prod
 * `--apply` and its dated 2026-10-17 Search Console follow-up, and US-9123's
 * verification against real Claude clients, appeared in no operator list at
 * all. They were not undeclared; they were unread.
 *
 * That is worse than an undeclared criterion, because an undeclared one at
 * least shows up in the audit tail where somebody might notice it. A file the
 * tool never opens produces no signal of any kind.
 *
 * Missing siblings are skipped rather than fatal: a partial checkout, or a
 * programme that has been fully archived and its file removed, must not stop
 * the queue printing.
 *
 * MERGING THEM IS SAFE, and this is the thing to check before widening any
 * other tool the same way. Measured 2026-08-22: 2,833 story ids across all
 * four files (these three plus the archive) and ZERO duplicates. The sibling
 * programmes live in the 9xxx range — highest is 9131 — while prd.json's
 * nextId is 2790, so the ranges cannot collide by accident.
 *
 * The other backlog tools (prd-lint, prd-story, archive-passing-stories,
 * prd-digest) all still read prd.json alone. That is a real limitation —
 * `prd-story.mjs note`/`ac` cannot touch a sibling, so those get hand-edited —
 * but it is not an integrity risk while the ranges stay apart. If a sibling
 * ever gets an id under 3000, that stops being true.
 */
const BACKLOG_FILES = ["prd.json", "prd-seo.json", "prd-connector.json"];

function loadBacklogs() {
  const stories = [];
  const read = [];
  for (const file of BACKLOG_FILES) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue; // absent is fine — see the note above
    }
    const parsed = JSON.parse(raw);
    const own = parsed.userStories ?? [];
    // Tag the source so a reader can tell which programme an id belongs to.
    for (const s of own) stories.push(file === "prd.json" ? s : { ...s, backlog: file });
    read.push(`${file} (${own.filter((s) => !s.passes).length} open)`);
  }
  return { stories, read };
}

/**
 * The inverse of this whole file: open stories that DO NOT wait on a person.
 *
 * WHY IT LIVES HERE. Everything above answers "what does the owner have to do".
 * Nobody could answer the other half — "what can be picked up right now" — and
 * the query kept getting hand-rolled, wrong, in one session after another. The
 * naive version is "no OPERATOR acceptance criterion", and it over-reports
 * badly: US-2710 through US-2713 have no operator step of their own and are
 * each blocked behind US-2709's question to counsel. A story you cannot start
 * is not actionable just because its own criteria look clean.
 *
 * So a story is actionable when it declares no operator step AND no story it
 * depends on, transitively, is open with one. Cycles terminate on the visited
 * set rather than recursing forever; a dependency that is closed or missing
 * blocks nothing, which is the same treatment namedByCount gives a dangling id.
 *
 * ⚠ THIS IS A CEILING, the mirror of the floor caveat below. It trusts the
 * DECLARED convention and the dependsOn field, and both are written by hand. A
 * story whose blocker is buried in prose is counted actionable here for exactly
 * the reason it is absent from the operator queue above. Three epics
 * (US-2472, US-2696, US-2703) sat in this list for months, fully blocked,
 * appearing in NEITHER section of the report — that is what prompted this.
 */
export function actionable(stories) {
  const open = stories.filter((s) => !s.passes);
  const byId = new Map(open.map((s) => [s.id, s]));
  // A TITLE TAG COUNTS TOO, and the first draft of this function missed it.
  // Four stories — US-9127, US-1421, US-2380, US-1582 — carry [OPERATOR] in the
  // title with no matching acceptance criterion, and `collect` above already
  // treats that as a signal (it is why they appear in UNDECLARED reading
  // "title tag only — no sentence to quote"). Reading only the criteria listed
  // all four as ready to pick up, which is the single most expensive kind of
  // wrong answer this function can give: it sends a session to open a story
  // whose first line says a person is required.
  //
  // [PARKED] is included for the same reason. It is not operator work, but a
  // parked story is not actionable either, and offering one as the next thing
  // to build is the same wasted read.
  const TITLE_TAG = /^\s*\[(?:OPERATOR|OWNER|HUMAN|PARKED)\]/i;
  const declaresOperator = (s) =>
    TITLE_TAG.test(String(s.title ?? "")) ||
    (s.acceptanceCriteria ?? []).some((a) => DECLARED_RE.test(String(a)));

  const blockedCache = new Map();
  function blocked(id, seen = new Set()) {
    if (blockedCache.has(id)) return blockedCache.get(id);
    if (seen.has(id)) return false; // a cycle blocks nothing; it just ends here
    seen.add(id);
    const s = byId.get(id);
    if (!s) return false; // closed or unknown: not a blocker
    const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    const result =
      deps.some((d) => {
        const dep = byId.get(String(d));
        return dep ? declaresOperator(dep) || blocked(dep.id, seen) : false;
      });
    blockedCache.set(id, result);
    return result;
  }

  return open
    .filter((s) => !declaresOperator(s))
    .filter((s) => !blocked(s.id))
    .map((s) => ({
      id: s.id,
      priority: s.priority,
      title: String(s.title ?? ""),
      noteLength: String(s.notes ?? "").length,
    }));
}

function main() {
  const argv = process.argv.slice(2);
  const { stories, read } = loadBacklogs();
  const { declared, undeclared, openCount, satisfied } = collect(stories);

  if (argv.includes("--sessions")) {
    const groups = groupBySession(declared, undeclared);
    const total = declared.length + undeclared.length;
    console.log(
      `\nOperator work, grouped into sittings: ${total} items across ${openCount} open stories.\n` +
        `Sessions are ordered so each one's results are still true when you reach the next.\n`,
    );
    for (const kind of SESSION_KINDS) {
      const rows = groups.get(kind.key);
      if (!rows.length) continue;
      console.log(`${kind.title}  —  ${rows.length} item(s)`);
      console.log(`   ${kind.hint}\n`);
      for (const r of rows) {
        console.log(`   ${rank(r)} ${r.id.padEnd(9)} ${String(r.title).slice(0, 76)}`);
      }
      console.log("");
    }
    const rest = groups.get("unclassified");
    if (rest.length) {
      console.log(`Unclassified  —  ${rest.length} item(s)`);
      console.log("   These matched no session pattern. Printed rather than dropped:");
      console.log("   a queue that silently loses items is worse than one that admits it.\n");
      for (const r of rest) {
        console.log(`   ${rank(r)} ${r.id.padEnd(9)} ${String(r.title).slice(0, 76)}`);
      }
      console.log("");
    }
    return;
  }

  if (argv.includes("--actionable")) {
    const rows = actionable(stories).sort(comparePriority);
    console.log(
      `\nActionable now: ${rows.length} of ${openCount} open stories declare no` +
        ` operator step and are not blocked behind one.\n`,
    );
    for (const r of rows) {
      const notes = r.noteLength > 0 ? `${Math.round(r.noteLength / 100) / 10}k notes` : "no notes";
      console.log(
        `  ${rank(r)} ${r.id.padEnd(9)} ${r.title.slice(0, 66).padEnd(66)} ${notes}`,
      );
    }
    console.log(
      "\nA CEILING, not a census. It trusts the OPERATOR convention and the",
    );
    console.log(
      "dependsOn field, both written by hand. A story whose blocker is only in",
    );
    console.log("prose is listed here for the same reason it is missing above.\n");
    return;
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ declared, undeclared, openCount, satisfied }, null, 2));
    return;
  }

  const total = declared.length + undeclared.length;
  console.log(
    `\nOperator queue: ${total} of ${openCount} open stories wait on a person.\n`,
  );
  // Counted, never silently dropped: an item that vanishes without a trace is
  // indistinguishable from one nobody ever wrote down.
  if (satisfied > 0) {
    console.log(
      `  (${satisfied} declared item(s) marked SATISFIED with a date, no longer listed.)\n`,
    );
  }

  // The whole queue sorted by priority is a list; this is the shortest path
  // through it. Only DECLARED rows are ranked — an undeclared one is a guess at
  // what a person is needed for, and guessing twice does not make it a plan.
  // Across ALL backlogs: a prd.json story can be waiting on a connector or SEO
  // one, and counting only prd.json would under-rank exactly the cross-programme
  // dependencies that are hardest to notice by reading.
  const namedBy = namedByCount(stories);
  const ranked = declared
    .map((s) => ({ ...s, blocks: namedBy.get(s.id)?.size ?? 0 }))
    .filter((s) => s.blocks > 0)
    .sort((a, b) => b.blocks - a.blocks || comparePriority(a, b));

  if (ranked.length > 0) {
    console.log("START HERE — operator work that other open stories are waiting on\n");
    for (const s of ranked.slice(0, 8)) {
      const who = [...(namedBy.get(s.id) ?? [])].sort().join(", ");
      console.log(`  ${String(s.blocks).padStart(2)}x  ${rank(s)} ${s.id}  ${s.title}`);
      console.log(`        named by: ${who}`);
      console.log(`        ${s.items[0].replace(DECLARED_RE, "").slice(0, 150)}`);
      console.log("");
    }
    console.log(
      "  A mention is evidence of a relationship, not proof of one — this counts\n" +
        "  stories that NAME each other, because dependencies here live in prose.\n",
    );
  }

  console.log(`DECLARED (${declared.length}) — an OPERATOR: acceptance criterion, quoted exactly`);
  if (declared.length === 0) console.log("  (none)");
  for (const s of declared) {
    console.log(`\n  ${rank(s)} ${s.id}  ${s.title}`);
    for (const item of s.items) console.log(`        - ${item.replace(DECLARED_RE, "").trim()}`);
  }

  if (argv.includes("--declared")) return;

  console.log(
    `\n\nUNDECLARED (${undeclared.length}) — the note says a human is needed; the story never`,
  );
  console.log("says so structurally. Sentences below are EVIDENCE, not instructions.");
  console.log("Read the story before acting: an extract can drop the qualifier.\n");
  const shown = argv.includes("--all") ? undeclared : undeclared.slice(0, 20);
  for (const s of shown) {
    console.log(`  ${rank(s)} ${s.id}  ${s.title.slice(0, 78)}`);
    for (const e of s.evidence.slice(0, 2)) console.log(`        > ${e}`);
    if (s.evidence.length === 0) console.log("        > (title tag only — no sentence to quote)");
  }
  if (shown.length < undeclared.length) {
    console.log(`\n  … ${undeclared.length - shown.length} more. Pass --all to see them.`);
  }

  if (argv.includes("--audit")) {
    const candidates = auditCandidates(prd.userStories ?? []);
    console.log(
      `\n\nAUDIT (${candidates.length}) — NOT findings. Open stories, not in either list`,
    );
    console.log("above, whose last note mentions anything that could mean a person.");
    console.log("Most are false positives. Read them; declare the real ones.\n");
    for (const s of candidates) {
      console.log(`  ${rank(s)} ${s.id}  ${s.title.slice(0, 74)}`);
      if (s.quote) console.log(`        > ${s.quote.slice(0, 190)}`);
    }
  }

  console.log(
    "\nTo move a story from the second list to the first, add an acceptance",
  );
  console.log("criterion that starts with OPERATOR: and says what to do.");
  console.log(
    "\nTHIS IS A FLOOR, NOT A CENSUS. It counts stories that SAY a person is",
  );
  console.log(
    "needed, in a form this script recognises. A story whose operator work is",
  );
  console.log(
    "buried in prose it does not match is simply absent — which is the argument",
  );
  console.log("for the convention, not a reason to trust the number as a total.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
