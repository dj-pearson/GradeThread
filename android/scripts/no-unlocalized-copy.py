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
            # Compose files belong to no-bare-strings.py. Two guards reporting
            # the same line teaches people to ignore both.
            if "@Composable" in src:
                continue
            rel = os.path.relpath(path, SOURCE).replace(os.sep, "/")
            for line in strip_comments(src).split("\n"):
                if MACHINE_LINE.search(line):
                    continue
                for match in LITERAL.finditer(line):
                    if is_copy(match.group(1)):
                        found[rel].add(match.group(1))
    return {k: sorted(v) for k, v in found.items() if v}


def load_baseline():
    with open(BASELINE_PATH, encoding="utf-8") as fh:
        return json.load(fh)["files"]


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
