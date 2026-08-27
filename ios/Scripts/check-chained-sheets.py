#!/usr/bin/env python3
"""Fail when a SwiftUI view carries more than one `.sheet` modifier.

WHY THIS IS A GUARD AND NOT A STYLE NOTE.

A view has ONE sheet slot. Writing

    someView
        .sheet(isPresented: $a) { A() }
        .sheet(isPresented: $b) { B() }

compiles, reads fine in review, and is undefined at runtime: the modifiers
compete for that one slot, and the ones that lose present and are torn down in
the same frame. To the person holding the phone the screen opens and closes on
its own, with nothing in the console and nothing in Sentry.

That is what happened to "Prospect an item" and "What's it worth?" — both were
the second and third sheet on views (Home and the Tools hub) that carried three
each. The Settings list carried nine. None of it was ever reported against the
sheet modifier, because the symptom looks like the module is broken rather than
the presentation.

The fix is always the same shape: one `Identifiable` enum naming the sheets, one
optional holding which is up, one `.sheet(item:)` switching over it. That also
states the mutual exclusion that was true all along — two of these could never
sensibly be on screen at once, and a pile of booleans said nothing about it.

WHAT COUNTS. Two `.sheet` modifiers in the SAME modifier chain: same
indentation, with only other modifiers (`.foo`), closing braces, or the
continuation lines of a multi-line modifier between them. Two sheets on
genuinely different views — a row and its list, a parent and its child — are
fine and are not flagged. `.fullScreenCover` is checked THE SAME WAY, as its own
kind: one sheet and one cover on a view is fine, two of either is not.

THREE HOLES THIS GUARD HAD, and why they are written down rather than quietly
patched. On 2026-08-27 the exact bug this script was written to prevent was
reported again from production — "What's it worth?" and "Prospect an item"
closing on submit, "Scout deals" doing nothing — while this script printed OK.
It had been green the whole time, over a shell view carrying three sheets.

1. A MULTI-LINE MODIFIER ENDED THE CHAIN. `.onReceive(` spanning three lines
   leaves `) { notification in` sitting at the chain's own indentation, and the
   sibling test accepted only `.`, `}` and `//`. So ContentView's shell read as
   three unrelated views instead of one chain. Any `(`, `)` or `,` continuation
   is accepted now.

2. A SHEET HIDDEN IN A VIEW EXTENSION WAS INVISIBLE. `.planGatePresentation()`
   is a `func … -> some View` whose body is a `.sheet(item:)`. To this scanner
   it was an ordinary modifier. Those wrappers are discovered by name across the
   tree now and counted as the sheets they are — which matters most because the
   wrapper IS the fix this guard recommends, so the recommended shape must not
   also be the way to hide from it.

3. `.fullScreenCover` WAS NEVER CHECKED AT ALL. The docstring said covers were
   "left alone; one of each on a view works", which is true of one cover and
   silent about two. The shell carried two and PhotoIntakeView carried two more.

All three share a property worth remembering: the guard did not fail, it
reported success over code it could not see. A scanner that cannot reach a
construct reads exactly like a clean codebase.
"""

import os
import re
import sys

SHEET = re.compile(r"\s*\.sheet\(")
# US-2925: `.fullScreenCover` has the SAME single-slot rule. This guard's own
# docstring used to say covers were "left alone; one of each on a view works" —
# true of ONE cover, and silent about two. The shell carried two, and
# PhotoIntakeView carried two more, entirely unexamined.
COVER = re.compile(r"\s*\.fullScreenCover\(")
KINDS = (("sheet", SHEET), ("fullScreenCover", COVER))
ROOTS = ["GradeThread", "Shared", "ShareExtension", "GradeThreadWidget"]

# `func name(...) -> some View` inside an `extension View`. See hole 2 below.
WRAPPER_DEF = re.compile(r"\bfunc\s+(\w+)\s*\([^)]*\)\s*->\s*some\s+View")


def indent_of(line):
    return len(line) - len(line.lstrip())


def sheet_wrappers(roots):
    """`extension View` helpers whose call presents a `.sheet`.

    A call to one of these IS a sheet modifier. The indirection is the pattern
    this guard RECOMMENDS — ToolModulePresentation.swift and
    PlanGatePresentation.swift are both this shape — so the recommended shape
    must not also be the way to hide from it.

    TWO SHAPES, and the first version of this function missed both of them,
    which is why they are spelled out:

      direct     `func x() -> some View { sheet(item: …) { … } }`
                 The call is on implicit self, so there is NO LEADING DOT. A
                 `".sheet(" in body` test finds nothing and reports clean.

      modifier   `func x() -> some View { modifier(XPresenter()) }`, where the
                 sheet lives in `struct XPresenter: ViewModifier`'s
                 `body(content:)`. Nothing in the function's own text mentions a
                 sheet at all.

    So: collect the ViewModifier structs that present a sheet first, then accept
    a wrapper that either presents one itself or delegates to one of them.
    """
    texts = []
    for top in roots:
        for dirpath, _, files in os.walk(top):
            for name in files:
                if name.endswith(".swift"):
                    texts.append(
                        open(os.path.join(dirpath, name), encoding="utf-8").read()
                    )

    # Pass 1: ViewModifier structs whose body presents a sheet.
    sheet_modifiers = set()
    for text in texts:
        for m in re.finditer(r"struct\s+(\w+)\s*:\s*ViewModifier\b", text):
            body = text[m.end(): m.end() + 6000]
            nxt = re.search(r"\nstruct\s+\w+", body)
            if nxt:
                body = body[: nxt.start()]
            if re.search(r"(?<![\w.])\.?sheet\s*\(", body):
                sheet_modifiers.add(m.group(1))

    delegates = (
        re.compile(r"modifier\s*\(\s*(?:" +
                   "|".join(sorted(re.escape(x) for x in sheet_modifiers)) + r")\s*\(")
        if sheet_modifiers else None
    )

    # Pass 2: extension View funcs that present one, directly or by delegation.
    names = set()
    for text in texts:
        if "extension View" not in text:
            continue
        parts = WRAPPER_DEF.split(text)
        for i in range(1, len(parts), 2):
            fn, body = parts[i], parts[i + 1]
            if fn == "body":
                continue  # a ViewModifier's own body, handled in pass 1
            nxt = body.find("\n}")
            scope = body[: nxt if nxt >= 0 else 4000]
            if re.search(r"(?<![\w.])\.?sheet\s*\(", scope) or (
                delegates and delegates.search(scope)
            ):
                names.add(fn)
    return names


def violations(path, wrappers=frozenset(), kind=SHEET):
    lines = open(path, encoding="utf-8").read().split("\n")
    wrapper_re = (
        re.compile(r"\s*\.(?:" + "|".join(sorted(re.escape(w) for w in wrappers)) + r")\s*\(")
        if wrappers
        else None
    )

    def is_sheet(line):
        return bool(kind.match(line) or (wrapper_re and wrapper_re.match(line)))

    sheets = [(i, indent_of(line)) for i, line in enumerate(lines) if is_sheet(line)]

    found = []
    for a in range(len(sheets)):
        first, indent = sheets[a]
        for b in range(a + 1, len(sheets)):
            second, indent2 = sheets[b]
            if indent2 != indent:
                continue
            # Same chain? Every line between them that sits at exactly this
            # indentation must be another modifier or a closing brace. Anything
            # else means a new view started and these are not siblings.
            same_chain = True
            for k in range(first + 1, second):
                line = lines[k]
                if not line.strip() or indent_of(line) != indent:
                    continue
                stripped = line.strip()
                # `)` `(` `,` are the continuation lines of a MULTI-LINE
                # modifier — see hole 1 below. They do not start a new view, and
                # treating them as though they did is what let a three-sheet
                # chain read as three separate, innocent views.
                if not (stripped.startswith(".")
                        or stripped.startswith("}")
                        or stripped.startswith(")")
                        or stripped.startswith("(")
                        or stripped.startswith(",")
                        or stripped.startswith("//")):
                    same_chain = False
                    break
            if same_chain:
                found.append((first + 1, second + 1, lines[first].strip(), lines[second].strip()))
            break  # only report each sheet against its nearest sibling
    return found


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    failures = []
    wrappers = sheet_wrappers(ROOTS)
    for top in ROOTS:
        for dirpath, _, files in os.walk(top):
            for name in files:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name).replace("\\", "/")
                for label, kind in KINDS:
                    # The wrapper helpers hide a `.sheet`, so they count only
                    # for the sheet pass.
                    ws = wrappers if kind is SHEET else frozenset()
                    for first, second, a, b in violations(path, ws, kind):
                        failures.append(
                            f"{path}:{second}: shares a {label} slot with line {first}\n"
                            f"    {a}\n"
                            f"    {b}"
                        )
    if failures:
        print("Views carrying more than one .sheet modifier:\n")
        for f in failures:
            print(f)
            print()
        print(f"{len(failures)} pair(s). Collapse each view's presentations "
              f"into ONE .sheet(item:) / .fullScreenCover(item:) over an enum.")
        return 1
    print("check-chained-sheets: every view carries at most one .sheet and one .fullScreenCover"
          + (f" (counting {len(wrappers)} view-extension wrapper(s))" if wrappers else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
