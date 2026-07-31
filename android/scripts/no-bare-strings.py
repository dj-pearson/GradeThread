#!/usr/bin/env python3
"""US-1393 — fail CI if a scoped Compose file shows a hardcoded UI string.

The Android counterpart to the iOS bare-strings rule. A literal passed to
`Text(...)`, `label = { Text(...) }`, `contentDescription = "..."` and friends
can never be translated, and nothing about it looks wrong in review — it renders
perfectly in English forever.

SCOPE IS DELIBERATE AND PARTIAL. Converting ~90 Compose files in one pass would
either fail the build everywhere or get the guard switched off, and a
switched-off guard protects nothing. The list below names the files that HAVE
been converted; it grows as more are, and a file inside the scope can never
regress.

Run locally:  python3 android/scripts/no-bare-strings.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "app", "src", "main", "java", "com", "gradethread", "app")

# Files whose UI text is fully externalized. ADD to this list when you convert
# a screen; never remove from it.
SCOPE = [
    "onboarding/OnboardingHost.kt",
    "referrals/ReferralsScreen.kt",
    "support/SupportScreen.kt",
    "support/SupportThreadScreen.kt",
    "feedback/FeedbackSheet.kt",
    "workspace/WorkspaceSwitcherRow.kt",
    "importer/ImportScreen.kt",
    "auth/AuthScreen.kt",
    "home/HomeScreen.kt",
    "money/MoneyScreen.kt",
    "settings/SettingsScreen.kt",
    "snap/SnapScreen.kt",
    "analytics/AnalyticsScreen.kt",
]

# A string literal handed to something that renders or speaks it.
UI_SINKS = re.compile(
    r"""
    (?:
        \bText\s*\(\s*"                     # Text("...")
      | contentDescription\s*=\s*"           # contentDescription = "..."
      | \btext\s*=\s*"                       # text = "..."
      | \blabel\s*=\s*"                      # label = "..."
      | placeholder\s*=\s*"
      | announceForAccessibility\s*\(\s*"
      | \btitle\s*=\s*"                       # title = "..." on a row/dialog
      | \bsubtitle\s*=\s*"
      | \bdescription\s*=\s*"                 # chart accessibility copy
      | SectionHeader\s*\(\s*"
      | Panel(?:Header)?\s*\(\s*"
      | InfoCard\s*\(\s*"
    )
    """,
    re.VERBOSE,
)

# Not user-facing: a route, a wire value, a key, a log category, a test tag.
EXEMPT = re.compile(
    r"""
    ^\s*(//|\*)                              # comment
  | \bTelemetry\.                             # analytics event names
  | \bbreadcrumb\s*\(
  | \bnavigate\s*\(
  | testTag\s*\(
    """,
    re.VERBOSE,
)

# An empty or whitespace-only literal is a spacer, not copy.
TRIVIAL = re.compile(r'"\s*"')

# The same sinks, but with the literal wrapped onto the NEXT line — which is
# what ktlint does to any argument list over 100 columns, so it is the COMMON
# shape, not an edge case. Missing it is how ~90 literals sat inside "converted"
# files: every one of them was a multi-line Text(...) the single-line rule
# could not see.
OPEN_SINK = re.compile(
    r"""
    (?:
        \bText\s*\($
      | contentDescription\s*=$
      | \btext\s*=$
      | \blabel\s*=$
      | \btitle\s*=$
      | \bsubtitle\s*=$
      | \bdescription\s*=$
      | SectionHeader\s*\($
      | Panel(?:Header)?\s*\($
      | InfoCard\s*\($
    )
    """,
    re.VERBOSE,
)


def scan(path):
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    offenders = []
    for i, line in enumerate(lines):
        if EXEMPT.search(line):
            continue
        match = UI_SINKS.search(line)
        if match:
            # The literal that follows the sink.
            tail = line[match.end() - 1:]
            if not TRIVIAL.match(tail):
                offenders.append((i + 1, line.strip()))
            continue
        if not OPEN_SINK.search(line.rstrip()):
            continue
        # Walk past comment lines to the first line that carries an argument.
        for offset, following in enumerate(lines[i + 1:], start=i + 2):
            stripped = following.strip()
            if not stripped or stripped.startswith(("//", "*", "/*")):
                continue
            if stripped.startswith('"') and not TRIVIAL.match(stripped):
                offenders.append((offset, stripped))
            break
    return offenders


def main():
    missing = [rel for rel in SCOPE if not os.path.isfile(os.path.join(SOURCE, rel))]
    if missing:
        # A renamed or deleted file must not silently drop out of the guard.
        print("no-bare-strings: scoped file not found:", file=sys.stderr)
        for rel in missing:
            print(f"  {rel}", file=sys.stderr)
        return 1

    failures = []
    for rel in SCOPE:
        for line_no, text in scan(os.path.join(SOURCE, rel)):
            failures.append((rel, line_no, text))

    if not failures:
        print(f"no-bare-strings: OK ({len(SCOPE)} files in scope)")
        return 0

    print("no-bare-strings: hardcoded UI text found\n", file=sys.stderr)
    for rel, line_no, text in failures:
        print(f"  {rel}:{line_no}: {text}", file=sys.stderr)
    print(
        "\nMove it to res/values/strings.xml and read it with "
        "stringResource(R.string.…) / pluralStringResource(R.plurals.…).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
