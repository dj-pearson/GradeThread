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


def scan(path):
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    offenders = []
    for i, line in enumerate(lines):
        if EXEMPT.search(line):
            continue
        match = UI_SINKS.search(line)
        if not match:
            continue
        # The literal that follows the sink.
        tail = line[match.end() - 1:]
        if TRIVIAL.match(tail):
            continue
        offenders.append((i + 1, line.strip()))
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
