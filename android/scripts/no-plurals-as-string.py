#!/usr/bin/env python3
"""US-3115 - keep string ids and plurals ids apart at the UiMessage boundary.

WHY THIS EXISTS AND NOT JUST LINT. `:app:lintDebug` already checks this: the
two factories on `UiMessage` carry `@StringRes` and `@PluralsRes`, so passing
the wrong kind is a `ResourceType` error. But that run takes about six minutes
and, when this was written, it could not be completed at all - 101 errors on
main, 31 of them exactly this. A check nobody can finish is a check nobody
runs, and the fix for that is a check that costs two seconds.

WHAT WENT WRONG, so the next reader knows what the shape is protecting. The
class held `@StringRes val res: Int` and, four fields later, a `quantity` whose
own KDoc said "when [res] is a PLURALS resource". So it was documented to carry
either kind and annotated to carry one, and lint was right in both directions at
once: every plurals caller was "Expected resource of type string", and the
renderer's own `pluralStringResource(res, ...)` was "Expected resource of type
plurals" on the very same field. An annotation cannot describe a union.

THREE RULES, and the third is the one a person would not think to add:

  1. `UiMessage(...)` is the STRING factory. A call carrying an `R.plurals.` id
     or a `quantity =` argument belongs on `UiMessage.plural(...)`.
  2. `UiMessage.plural(...)` is the PLURALS factory. A call carrying an
     `R.string.` id belongs on `UiMessage(...)`.
  3. `app/lint-baseline.xml` may not carry a `ResourceType` entry. Baselining
     is the cheap way out of both rules above and it hides a real
     contradiction: after it, nobody can tell an intentional plurals id from a
     genuine wrong-resource bug, which is the thing `ResourceType` is for.
     The same goes for `PluralsCandidate` (mobile plan action 7): the 35 rows
     it carried were each a count sentence Spanish could not inflect, and they
     were converted to <plurals> or marked `tools:ignore` on the string with a
     reason. Baselining a new one hides exactly that again.
  4. Nothing renders `someMessage.res` itself. Use `text()`.

     ⚠ RULE 4 IS THE ONE THAT IS NOT OBVIOUS, and it is the cost of the split.
     Dropping `@StringRes` off the field is what let the union exist, and it
     also stopped lint from watching that field - so `stringResource(it.res)`
     on a message that now holds a plurals id compiles, passes lint, and throws
     at the seller. Eight screens were doing exactly that, each hand-rolling
     `it.detail ?: stringResource(it.res, ...)`, which is `text()` copied by
     hand and then left behind when `text()` learned about plurals.

Scans app/src/main, app/src/test and app/src/androidTest.

Run locally:  python3 android/scripts/no-plurals-as-string.py
Self-test:    python3 android/scripts/no-plurals-as-string.py --self-test
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIRS = [
    os.path.join(ROOT, "app", "src", "main"),
    os.path.join(ROOT, "app", "src", "test"),
    os.path.join(ROOT, "app", "src", "androidTest"),
]
LINT_BASELINE = os.path.join(ROOT, "app", "lint-baseline.xml")

CALL = re.compile(r"UiMessage(\.plural)?\(")
QUANTITY_ARG = re.compile(r"\bquantity\s*=")
# `stringResource(x.res` / `context.getString(x.res` - the renderer, hand-rolled.
RAW_RENDER = re.compile(r"\b(?:stringResource|getString)\(\s*[A-Za-z_][\w.]*\.res\b")


def _balanced_body(src, open_index):
    """The text between the parens of a call whose '(' is at `open_index`.

    Counting depth rather than reading to the first ')' - a UiMessage call
    almost always wraps another call (`listOf(...)`, `format(...)`), and a
    first-close-paren scan reads a fraction of the arguments and finds nothing.
    """
    depth = 1
    i = open_index + 1
    while i < len(src) and depth:
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
        i += 1
    return src[open_index + 1 : i - 1]


def scan_source(src, path):
    """Rules 1 and 2 over one file's text."""
    problems = []
    for m in CALL.finditer(src):
        is_plural = m.group(1) is not None
        body = _balanced_body(src, m.end() - 1)
        line = src[: m.start()].count("\n") + 1
        if not is_plural and ("R.plurals." in body or QUANTITY_ARG.search(body)):
            problems.append(
                f"{path}:{line}: a plurals id or a quantity on the string "
                f"factory - use UiMessage.plural(...)"
            )
        elif is_plural and "R.string." in body:
            problems.append(
                f"{path}:{line}: a string id on the plurals factory - "
                f"use UiMessage(...)"
            )
    for m in RAW_RENDER.finditer(src):
        line = src[: m.start()].count("\n") + 1
        problems.append(
            f"{path}:{line}: rendering .res directly - a plurals id here throws "
            f"at the seller; use text()"
        )
    return problems


def scan_tree():
    problems = []
    for source_dir in SOURCE_DIRS:
        if not os.path.isdir(source_dir):
            continue
        for dirpath, _, filenames in os.walk(source_dir):
            for filename in filenames:
                if not filename.endswith(".kt"):
                    continue
                full = os.path.join(dirpath, filename)
                # The declaration is the one place both ids are legitimately
                # one field, which is the whole point of the split.
                if filename == "UiMessage.kt":
                    continue
                with open(full, encoding="utf8") as handle:
                    src = handle.read()
                problems += scan_source(src, os.path.relpath(full, ROOT).replace("\\", "/"))
    return problems


#: Lint ids that may never be absorbed into the baseline, and what to do instead.
BANNED_BASELINE_IDS = {
    "ResourceType": "US-3115 forbids baselining this rule; fix the call site instead",
    "PluralsCandidate": (
        "a count sentence needs <plurals> in values/ and values-es/, or "
        "tools:ignore=\"PluralsCandidate\" on the string when the number is "
        "not a count (a row number, a percent)"
    ),
}


def scan_baseline_xml(xml):
    """Rule 3 over the baseline's text."""
    problems = []
    for rule, fix in BANNED_BASELINE_IDS.items():
        count = len(re.findall(r'id="%s"' % rule, xml))
        if count:
            problems.append(
                f"app/lint-baseline.xml: {count} {rule} entr"
                f"{'y' if count == 1 else 'ies'} - {fix}"
            )
    return problems


def scan_baseline():
    """Rule 3."""
    if not os.path.isfile(LINT_BASELINE):
        return []
    with open(LINT_BASELINE, encoding="utf8") as handle:
        return scan_baseline_xml(handle.read())


def self_test():
    """Each rule must reject something and accept its control.

    A guard is only worth its runtime if it has been watched to fail. These
    cases are the four mutations that would otherwise reintroduce the bug.
    """
    cases = [
        ("plurals id on the string factory",
         'val m = UiMessage(R.plurals.x, args = listOf(n))', True),
        ("quantity on the string factory",
         'val m = UiMessage(res, quantity = n)', True),
        ("string id on the plurals factory",
         'val m = UiMessage.plural(R.string.x, quantity = n)', True),
        ("a plurals id nested deep in the arguments",
         'val m = UiMessage(\n  R.string.wrap,\n  args = listOf(\n    UiMessage(R.plurals.inner, quantity = 1),\n  ),\n)', True),
        ("control: an ordinary string message",
         'val m = UiMessage(R.string.x, args = listOf(n))', False),
        ("control: an ordinary plural message",
         'val m = UiMessage.plural(R.plurals.x, quantity = n)', False),
        ("the renderer hand-rolled at a screen",
         'Text(it.detail ?: stringResource(it.res, *it.args.toTypedArray()))', True),
        ("the same thing with a Context",
         'val s = context.getString(message.res)', True),
        ("control: rendering through text()",
         'Text(it.text())', False),
        ("control: an unrelated stringResource",
         'Text(stringResource(R.string.title))', False),
    ]
    baseline_cases = [
        ("a ResourceType row in the baseline",
         '<issues><issue id="ResourceType" message="x"/></issues>', True),
        ("a PluralsCandidate row in the baseline",
         '<issues><issue\n        id="PluralsCandidate"\n        message="x"/></issues>', True),
        ("control: a baseline of other rules",
         '<issues><issue id="UseKtx" message="x"/></issues>', False),
    ]
    failures = []
    for name, src, should_flag in cases:
        flagged = bool(scan_source(src, "case.kt"))
        if flagged != should_flag:
            failures.append(
                f"  self-test: {name} - expected "
                f"{'a finding' if should_flag else 'no finding'}, got the opposite"
            )
    for name, xml, should_flag in baseline_cases:
        if bool(scan_baseline_xml(xml)) != should_flag:
            failures.append(
                f"  self-test: {name} - expected "
                f"{'a finding' if should_flag else 'no finding'}, got the opposite"
            )
    cases = cases + baseline_cases
    if failures:
        print("no-plurals-as-string self-test FAILED:")
        print("\n".join(failures))
        return 1
    print(f"no-plurals-as-string self-test: {len(cases)} cases, all as expected.")
    return 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    problems = scan_tree() + scan_baseline()
    if problems:
        print("String and plurals resource ids are mixed up (US-3115):\n")
        print("\n".join(problems))
        print(f"\n{len(problems)} problem(s).")
        return 1
    print("no-plurals-as-string: string ids and plurals ids stay apart.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
