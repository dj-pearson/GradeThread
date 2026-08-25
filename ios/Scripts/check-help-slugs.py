#!/usr/bin/env python3
"""US-2874 AC4 — every help slug named in Swift must exist in the shared registry.

WHY THIS IS A GUARD AND NOT A CODE REVIEW.

A help slug is a string that reaches the server. `HelpSlug.snapToValue` is
checked by the compiler; the string it resolves to is not, and neither is a
slug somebody adds to the fenced table by hand. A typo does not crash, does not
log, and does not reach Sentry: the sheet opens, the server answers 404, and the
sheet closes again. To the person holding the phone the help button is simply
dead, which reads as "this app has no help" rather than as a bug worth
reporting.

Two directions are checked, because only one of them is obvious:

  SWIFT -> REGISTRY  every `case x = "slug"` in HelpSlugs.swift must be a slug
      the TypeScript registry defines. This is the typo case.

  REGISTRY -> SWIFT  is deliberately NOT enforced here. The web registry may
      legitimately carry a surface iOS does not have, and failing on that would
      make adding a web-only help article an iOS problem. The Vitest parity test
      (src/test/ios-help-slugs-parity.test.ts) is what holds the two in step; it
      can import the registry properly, which this script cannot.

Also checked: no Swift file may pass a bare string where a HelpSlug belongs.
`HelpSheet(slug: "snap-to-value")` would compile only if someone widened the
type, and that widening is the moment the compiler stops helping.

Exits non-zero with the offending locations; mirrors no-ungated-print.py.
"""
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)

SWIFT_SLUGS = os.path.join(ROOT, "GradeThread", "Help", "HelpSlugs.swift")
TS_REGISTRY = os.path.join(REPO, "src", "lib", "help-slugs.ts")

# `case yourFirstGrade = "your-first-grade"`
SWIFT_CASE = re.compile(r'^\s*case\s+\w+\s*=\s*"([a-z0-9-]+)"', re.MULTILINE)
# `slug: "your-first-grade",` in the TS registry.
TS_SLUG = re.compile(r'^\s*slug:\s*"([a-z0-9-]+)"', re.MULTILINE)
# A literal where a HelpSlug belongs.
BARE_SLUG_ARG = re.compile(r'\bslug:\s*"')


def read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def strip_comments(text):
    """Drop // and /* */ so the guard never fires on prose about itself.

    This has caught out five separate scans on this epic, including one in this
    same story: the doc comment above names slugs in example code.
    """
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return re.sub(r"^\s*///?.*$", "", text, flags=re.MULTILINE)


def main():
    problems = []

    if not os.path.exists(SWIFT_SLUGS):
        print(f"[help-slugs] {SWIFT_SLUGS} is missing", file=sys.stderr)
        return 1
    if not os.path.exists(TS_REGISTRY):
        print(f"[help-slugs] {TS_REGISTRY} is missing", file=sys.stderr)
        return 1

    registry = set(TS_SLUG.findall(read(TS_REGISTRY)))
    swift_cases = SWIFT_CASE.findall(strip_comments(read(SWIFT_SLUGS)))

    # Guards the guard. Both empty is what a rename or a moved file looks like,
    # and it reads exactly like a clean pass.
    if len(registry) < 10:
        print(
            f"[help-slugs] only parsed {len(registry)} slugs out of the "
            "TypeScript registry -- the pattern has stopped matching",
            file=sys.stderr,
        )
        return 1
    if len(swift_cases) < 10:
        print(
            f"[help-slugs] only parsed {len(swift_cases)} cases out of "
            "HelpSlugs.swift -- the pattern has stopped matching",
            file=sys.stderr,
        )
        return 1

    for slug in swift_cases:
        if slug not in registry:
            problems.append(
                f"HelpSlugs.swift: '{slug}' is not in src/lib/help-slugs.ts"
            )

    seen = set()
    for slug in swift_cases:
        if slug in seen:
            problems.append(f"HelpSlugs.swift: '{slug}' is listed twice")
        seen.add(slug)

    # A bare string where the enum belongs, anywhere in the app.
    for base, dirs, files in os.walk(os.path.join(ROOT, "GradeThread")):
        dirs[:] = [d for d in dirs if d not in {"Preview Content"}]
        for name in files:
            if not name.endswith(".swift"):
                continue
            path = os.path.join(base, name)
            if os.path.abspath(path) == os.path.abspath(SWIFT_SLUGS):
                continue
            body = strip_comments(read(path))
            for i, line in enumerate(body.split("\n"), start=1):
                if BARE_SLUG_ARG.search(line):
                    rel = os.path.relpath(path, REPO)
                    problems.append(
                        f"{rel}:{i}: a bare string where a HelpSlug belongs -- "
                        "use HelpSlug.someCase so the compiler checks it"
                    )

    if problems:
        print("[help-slugs] FAIL", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1

    print(
        f"[help-slugs] OK - {len(swift_cases)} Swift slugs, all present in the "
        f"{len(registry)}-entry registry."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
