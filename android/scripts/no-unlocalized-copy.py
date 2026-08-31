#!/usr/bin/env python3
"""Fail CI when English user copy grows in a file that cannot translate it.

THE GAP THIS CLOSES. `no-bare-strings.py` finds a literal AT A RENDERING SINK
-- `Text("Save")`, `contentDescription = "..."` -- and it only looks at Compose
files. That catches the common mistake and misses the systematic one: copy
written in a plain Kotlin object, returned as a String, and rendered somewhere
else entirely. `Text(state.error)` has no literal in it, so the guard sees a
clean screen, and the English is three files away in an error mapper.

That is not a small residue. The first run of this script found 650 such
strings across 157 files, in an app that ships 1,537 fully translated resources
and declares a Spanish locale. A Spanish seller reads Spanish until something
goes wrong, and then reads English -- on error toasts, on notification channel
names in system settings, and on the validation under a form field.

WHAT IT REPORTS. A string literal, in a non-Compose file under the app source,
that reads like a sentence a person would be shown: at least twelve characters,
at least two lowercase words, starting with a capital. Deliberately a
heuristic, and deliberately a loose one -- the cost of a false positive is one
baseline line with a reason on it, and the cost of a false negative is a
shipped screen nobody can read.

HOW IT RATCHETS. BASELINE holds the count of known strings per file. A file may
never gain one; a file that loses them must have its number lowered in the same
commit, which is what stops the baseline from being a place things quietly go
to be forgotten. A file not in BASELINE may have none at all.

Run locally:  python3 android/scripts/no-unlocalized-copy.py
              python3 android/scripts/no-unlocalized-copy.py --list <path>
              python3 android/scripts/no-unlocalized-copy.py --rebaseline
"""
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import label_rule  # noqa: E402  (path set above so this runs from any cwd)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "app", "src", "main", "java", "com", "gradethread", "app")
BASELINE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unlocalized-copy-baseline.json")

LITERAL = re.compile(r'"((?:[^"\\\n]|\\.)*)"')

# A literal that is plainly machine-facing rather than person-facing.
NOT_COPY = re.compile(
    r"""^(
        https?://              # a URL
      | [a-z0-9_.\-/]+$        # an identifier, path or wire key
      | [A-Z0-9_]+$            # a constant
      | (application|image|text|multipart)/   # a MIME type
      | %[sd@]                 # a bare format placeholder
    )""",
    re.X,
)

# Room @Query bodies read exactly like sentences to a heuristic and are not copy.
SQL = re.compile(
    r"^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|PRAGMA|REPLACE)\b"
    r"|\bFROM\s+[a-z_]+|\bWHERE\b|\bORDER BY\b",
    re.I,
)

# Lines whose literals are wire contracts or patterns, never shown to anyone.
MACHINE_LINE = re.compile(r"@SerialName|@Named|@Query|@ColumnInfo|^\s*import\s|Regex\(")


# Files whose English is read by a DEVELOPER, not by a seller (US-2976 AC5).
#
# is_copy is a sentence detector and cannot tell "Your session expired" from
# "Queued photo delete has no photo_id". The second is a diagnostic: it is
# thrown, stored on the mutation row, and read by whoever is debugging a stuck
# queue. Translating it would be worse than leaving it - a Spanish stack trace
# helps nobody, and the words are how you find the throw site.
#
# The bar is "no user can reach it", not "it looks technical". Each entry names
# the path that was checked. STALENESS IS CHECKED below.
DIAGNOSTIC_FILES = {
    "sync/MutationReplayer.kt": (
        "Payload-shape failures from the offline queue. Every one goes through "
        "terminal() -> EdgeApiError.BadRequest -> MutationQueue.describe() -> "
        "the `lastError` column, and NOTHING in the app reads that column back "
        "(checked 2026-08-30: no `.lastError` reader outside Daos, Entities and "
        "MutationQueue). They are stored diagnostics. If an inspector screen is "
        "ever built, DELETE THIS ENTRY - these strings become user-facing the "
        "day something renders them."
    ),
}

# Files whose display positions hold vocabulary somebody else owns (US-2976 AC5).
#
# The label rule is positional, so it cannot tell a word this product chose from
# a word another company did. These entries are that judgement, written down.
# STALENESS IS CHECKED below: an entry naming a file the rule finds nothing in
# fails, so a reason cannot outlive the thing it excuses.
#
# A value is either a string (the whole file is excluded) or a (reason, values)
# pair, which excludes only those values. The pair form exists because a file
# can hold both: SubscriptionCatalog.kt carries the names of things we SELL and
# the words "Monthly" and "Yearly" in adjacent enums, and excluding the file
# would have quietly kept the second pair in English.
LABEL_VOCABULARY = {
    # US-2976: the TWO-OWNERS shape, three times over. One value was doing two
    # jobs and only one of the jobs is the seller's, so the enum gained a second
    # field: the seller reads the resource, and this English string is recorded
    # for whoever reads the row afterwards. Filing Spanish disputes or Spanish
    # bug reports under a reason nobody can group with the English ones is the
    # cost of translating these, and it is silent.
    "grading/Disputes.kt": (
        "DisputeReason.record, concatenated into the submitted dispute by "
        "DisputeComposer.compose and read by a GradeThread reviewer. The chip "
        "the seller taps is DisputeReason.label and IS translated.",
        [
            "Overall grade is too low",
            "Intentional design counted as damage",
            "A listed defect isn't actually present",
            "An important detail or flaw was missed",
            "Wrong garment type or category",
            "A factor score looks wrong",
            "Other (please explain)",
        ],
    ),
    "feedback/Feedback.kt": (
        "Feedback.Category.triage, the prefix Feedback.compose puts in front of "
        "the stored message so support can group the rows. The chip the seller "
        "taps is Category.label and IS translated.",
        ["I wish it did…", "This worked well"],
    ),
    # US-2976: the same two-owners shape, and the costliest instance of it.
    # These strings are PERSISTED onto a calibration line and then drawn into
    # the overlay image the BUYER sees - formatInches(line.label, line.inches)
    # in services/edge-functions/src/lib/measure-overlay.ts - as well as being
    # the key src/lib/measurements.ts matches on. Translating them would burn
    # Spanish into a listing photo aimed at an English-speaking buyer, and
    # nothing on the seller's screen would look wrong while it happened.
    "inventory/MeasurementCatalog.kt": (
        "Spec.label, persisted with a calibration line and rendered into the "
        "buyer-facing overlay by the edge. What the SELLER reads is "
        "Spec.display / MeasurementCatalog.display(), which IS translated.",
        [
            "Chest (pit to pit)",
            "Waist (flat)",
            "Front rise",
            "Leg opening",
            "Insole length",
            "US size",
            "Strap drop",
            "Handle drop",
            "First to last hole (belts)",
            "Head circumference (inside)",
            "Crown height",
            "Brim length",
            "Case diameter",
            "Lug width",
            "Band length",
            # aspectCandidates: eBay's OWN field names, matched against the
            # aspect list eBay returns for a category. A translated one matches
            # nothing, so the publish quietly stops filling that blank and the
            # seller is asked to type a measurement the item already carries.
            # Same class as marketplaces/publish/EbayCondition.kt below.
            "Inseam Length",
            "Front Rise",
            "Hem Width",
            "Shoulder to Shoulder",
            "Garment Length",
            "Shoe Size",
            "Case Size",
            "Bust Size",
            "Strap Length",
            "Bust",
            "Chest",
            "Waist",
            "Hip",
            "Inseam",
            "Sleeve",
            "Shoulder",
            "Length",
            "Width",
            "Height",
            "Depth",
            "Insole",
        ],
    ),
    "billing/SubscriptionCatalog.kt": (
        "Product names, not words. A seller who reads about Pro in a Spanish "
        "support thread has to find Pro on the paywall. The billing PERIODS in "
        "the same file are translated, which is why this is a value list and "
        "not the whole file.",
        ["Starter", "Pro", "Business"],
    ),
    "marketplaces/publish/EbayCondition.kt": (
        "eBay's own condition vocabulary. Note the reason is NOT the one "
        "US-2976 AC5 gives: [wire] carries the API value, so translating "
        "[label] would not break publishing. The real argument is that a "
        "seller picking a condition is choosing an eBay grade whose meaning "
        "eBay defines, and a Spanish gloss of 'Pre-owned - Excellent' would "
        "be our word for their category."
    ),
}


def strip_comments(src):
    """Blank out // and /* */ while leaving string literals and line count intact.

    Written by hand rather than with a regex: a regex that removes comments will
    eventually remove the inside of a string containing `//`, which is every URL
    in the file, and the resulting under-report looks exactly like a clean scan.
    """
    out = []
    i, n = 0, len(src)
    in_string = False
    while i < n:
        ch = src[i]
        if in_string:
            out.append(ch)
            if ch == "\\":
                out.append(src[i + 1] if i + 1 < n else "")
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if src.startswith("//", i):
            end = src.find("\n", i)
            end = n if end < 0 else end
            out.append(" " * (end - i))
            i = end
            continue
        if src.startswith("/*", i):
            end = src.find("*/", i)
            end = n if end < 0 else end + 2
            out.append("".join(c if c == "\n" else " " for c in src[i:end]))
            i = end
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def is_copy(value):
    if len(value) < 12:
        return False
    if NOT_COPY.match(value):
        return False
    if SQL.search(value):
        return False
    if " " not in value:
        return False
    if not re.match(r"^[A-Z]", value):
        return False
    return len(re.findall(r"\b[a-z]{2,}\b", value)) >= 2


def scan():
    """{relative path: sorted unique strings} for every non-Compose source file."""
    found = collections.defaultdict(set)
    for dirpath, _dirs, filenames in os.walk(SOURCE):
        for filename in sorted(filenames):
            if not filename.endswith(".kt"):
                continue
            path = os.path.join(dirpath, filename)
            with open(path, encoding="utf-8") as fh:
                src = fh.read()
            stripped = strip_comments(src)
            # Compose files belong to no-bare-strings.py. Two guards reporting
            # the same line teaches people to ignore both.
            #
            # Tested against the STRIPPED source, and that is not fussiness. On
            # a raw-text test, any file mentioning the annotation in a comment
            # opts itself out of this guard -- which is an opt-out available to
            # anyone, silently, by writing prose. It happened within an hour of
            # this script being written: a KDoc sentence explaining why a push
            # enum holds resource ids named the annotation, and the file left
            # the scan.
            if "@Composable" in stripped:
                continue
            rel = os.path.relpath(path, SOURCE).replace(os.sep, "/")
            excluded = LABEL_VOCABULARY.get(rel)
            # A value list applies to BOTH rules. The two-owners strings -
            # DisputeReason.record, Feedback.Category.triage - are sentences, so
            # is_copy finds them, and leaving them counted would put copy that
            # will never be translated in the "remaining work" number.
            by_value = set(excluded[1]) if excluded and not isinstance(excluded, str) else set()
            if rel not in DIAGNOSTIC_FILES:
                for line in stripped.split("\n"):
                    if MACHINE_LINE.search(line):
                        continue
                    for match in LITERAL.finditer(line):
                        if is_copy(match.group(1)) and match.group(1) not in by_value:
                            found[rel].add(match.group(1))
            # US-2976: the same file, read a second way. is_copy finds
            # sentences; this finds the Title Case and single words a person
            # reads off a tab bar, which are invisible to a sentence detector
            # by construction.
            if not isinstance(excluded, str):
                # NOT_COPY again, and it is load-bearing rather than tidy. The
                # positional rule merges the display indexes of every class in
                # a file, so an unrelated call putting a wire value at the same
                # index is read as a label: without this, ItemDraft.kt reported
                # `acquired_price`, `sku` and `sold`, and a baseline full of
                # column names is exactly the place things go to be forgotten.
                found[rel] |= {
                    value
                    for value in label_rule.labels_in(stripped)
                    if value not in by_value
                    and not NOT_COPY.match(value)
                    and re.search(r"[A-Za-z]", value)
                }
    return {k: sorted(v) for k, v in found.items() if v}


def diagnostics_are_current():
    """Every DIAGNOSTIC_FILES entry still names a file with sentences in it.

    Same rule as LABEL_VOCABULARY: an entry that excuses nothing reads as though
    somebody checked it recently.
    """
    stale = []
    for rel in sorted(DIAGNOSTIC_FILES):
        path = os.path.join(SOURCE, *rel.split("/"))
        if not os.path.exists(path):
            stale.append(f"{rel}: no such file")
            continue
        with open(path, encoding="utf-8") as fh:
            stripped = strip_comments(fh.read())
        found_any = False
        for line in stripped.split("\n"):
            if MACHINE_LINE.search(line):
                continue
            for m in LITERAL.finditer(line):
                if is_copy(m.group(1)):
                    found_any = True
                    break
            if found_any:
                break
        if not found_any:
            stale.append(f"{rel}: no sentence-shaped strings left to exclude")
    return stale


def vocabulary_is_current():
    """Every LABEL_VOCABULARY entry still names a file that has labels.

    Without this the map is where reasons go to be forgotten: a file renamed or
    emptied leaves an entry that excuses nothing and reads as though somebody
    checked it recently.
    """
    stale = []
    for rel in sorted(LABEL_VOCABULARY):
        path = os.path.join(SOURCE, *rel.split("/"))
        if not os.path.exists(path):
            stale.append(f"{rel}: no such file")
            continue
        with open(path, encoding="utf-8") as fh:
            stripped = strip_comments(fh.read())
        # BOTH rules, because a value list now filters both. The two-owners
        # strings are sentences, so only is_copy sees them - checking the label
        # rule alone reported a live entry as stale.
        labels = label_rule.labels_in(stripped)
        labels |= {
            m.group(1)
            for line in stripped.split("\n")
            if not MACHINE_LINE.search(line)
            for m in LITERAL.finditer(line)
            if is_copy(m.group(1))
        }
        if not labels:
            stale.append(f"{rel}: neither rule finds anything to exclude")
            continue
        entry = LABEL_VOCABULARY[rel]
        if not isinstance(entry, str):
            missing = sorted(set(entry[1]) - labels)
            if missing:
                stale.append(f"{rel}: no longer carries {', '.join(repr(m) for m in missing)}")
    return stale


def load_baseline():
    with open(BASELINE_PATH, encoding="utf-8") as fh:
        return json.load(fh)["files"]


def label_discovery_test():
    """US-2976 AC4: a NEW file carrying a display label must be found by itself.

    Returns an error line, or None.

    Written INSIDE `SOURCE` on purpose, the same as no-bare-strings.py's
    discovery test. A temp directory would exercise the matcher, which was never
    the doubt: the doubt is whether a file nobody registered anywhere is reached
    and read the second way. The probe is the exact shape from this story - a
    five-item bottom bar - because no-bare-strings.py reports that file CLEAN.
    """
    import tempfile

    probe = None
    try:
        fd, probe = tempfile.mkstemp(prefix="ZzLabelProbe", suffix=".kt", dir=SOURCE)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(
                "package com.gradethread.app\n\n"
                "enum class ZzLabelProbe(val route: String, val label: String) {\n"
                '    ONE("one", "Marketplaces"),\n'
                "}\n"
            )
        rel = os.path.relpath(probe, SOURCE).replace(os.sep, "/")
        found = scan().get(rel, [])
        if "Marketplaces" not in found:
            return (
                f"LABEL DISCOVERY FAILED: {rel} carries a display label and the scan "
                f"returned {found!r}. A new screen is outside the rule again, which is "
                "the bug US-2976 exists for and it is silent."
            )
        return None
    except OSError as exc:
        return f"LABEL DISCOVERY FAILED: could not write a probe ({exc})"
    finally:
        if probe and os.path.exists(probe):
            os.unlink(probe)


def self_test():
    """The rule has to still fire. A guard that stops matching reads as clean."""
    must_flag = [
        "Your session expired. Sign in again to continue.",
        "We couldn't reach the matcher just now.",
        "When eBay reports a sold listing.",
    ]
    must_ignore = [
        "https://gradethread.com/app/auth-callback",
        "application/json; charset=utf-8",
        "SELECT * FROM inventory_items WHERE id = :id",
        "sale.created",
        "SUPABASE_ANON_KEY",
        "Save",
    ]
    bad = [s for s in must_flag if not is_copy(s)] + [s for s in must_ignore if is_copy(s)]
    if bad:
        print("no-unlocalized-copy: SELF-TEST FAILED on:", file=sys.stderr)
        for s in bad:
            print(f"  {s!r}", file=sys.stderr)
        return False
    # The comment stripper must not eat a URL's slashes.
    if '"https://x/y"' not in strip_comments('val a = "https://x/y" // note'):
        print("no-unlocalized-copy: SELF-TEST FAILED: strip_comments ate a literal", file=sys.stderr)
        return False
    # ...and it MUST eat the annotation name out of a comment, or any file can
    # leave this scan by mentioning @Composable in prose.
    if "@Composable" in strip_comments("/** why no @Composable reaches it */\nval a = 1"):
        print(
            "no-unlocalized-copy: SELF-TEST FAILED: a comment can opt a file out of the scan",
            file=sys.stderr,
        )
        return False
    # US-2976: the label rule has its own cases, including the exact bottom-bar
    # shape every other guard in this repo reported as clean.
    label_failures = label_rule.self_test()
    if label_failures:
        print("no-unlocalized-copy: LABEL RULE SELF-TEST FAILED:", file=sys.stderr)
        for failure in label_failures:
            print(f"  {failure}", file=sys.stderr)
        return False
    discovery = label_discovery_test()
    if discovery:
        print(f"no-unlocalized-copy: {discovery}", file=sys.stderr)
        return False
    stale = vocabulary_is_current() + diagnostics_are_current()
    if stale:
        print("no-unlocalized-copy: an exclusion list is stale:", file=sys.stderr)
        for entry in stale:
            print(f"  {entry}", file=sys.stderr)
        print(
            "  An entry that excuses nothing reads as though somebody checked it.",
            file=sys.stderr,
        )
        return False
    return True


def main(argv):
    if "--list" in argv:
        target = argv[argv.index("--list") + 1]
        for value in scan().get(target, []):
            print(value)
        return 0

    found = scan()

    if "--rebaseline" in argv:
        payload = {
            "_comment": (
                "Per-file counts of English copy in non-Compose sources. A file may never "
                "gain one; a file that loses them lowers its number in the same commit. "
                "Regenerate with: python3 android/scripts/no-unlocalized-copy.py --rebaseline"
            ),
            "files": {k: len(v) for k, v in sorted(found.items())},
        }
        with open(BASELINE_PATH, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        print(f"no-unlocalized-copy: baselined {sum(len(v) for v in found.values())} strings "
              f"in {len(found)} files")
        return 0

    if not self_test():
        return 1

    baseline = load_baseline()
    grew, shrank, new = [], [], []
    for path, values in sorted(found.items()):
        allowed = baseline.get(path)
        if allowed is None:
            new.append((path, values))
        elif len(values) > allowed:
            grew.append((path, len(values), allowed, values))
        elif len(values) < allowed:
            shrank.append((path, len(values), allowed))
    for path, allowed in sorted(baseline.items()):
        if path not in found and allowed > 0:
            shrank.append((path, 0, allowed))

    if not (grew or new or shrank):
        total = sum(len(v) for v in found.values())
        print(f"no-unlocalized-copy: OK ({total} known strings in {len(found)} files, none added)")
        return 0

    for path, values in new:
        print(f"\n{path}: {len(values)} English strings in a file that cannot translate them.")
        for value in values[:8]:
            print(f"    {value!r}")
        if len(values) > 8:
            print(f"    ... and {len(values) - 8} more")
    for path, now, allowed, values in grew:
        print(f"\n{path}: {now} English strings, baseline allows {allowed}.")
        for value in values[:8]:
            print(f"    {value!r}")
    for path, now, allowed in shrank:
        print(f"\n{path}: down to {now} from {allowed} -- lower the baseline in this commit.")

    print(
        "\nMove copy into res/values/strings.xml and res/values-es/strings.xml, and return a\n"
        "@StringRes id from the plain-Kotlin side (TwoFactorPolicy.message is the pattern).\n"
        "Then: python3 android/scripts/no-unlocalized-copy.py --rebaseline",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
