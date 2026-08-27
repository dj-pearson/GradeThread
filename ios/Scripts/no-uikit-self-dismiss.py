#!/usr/bin/env python3
r"""Fail when a UIViewControllerRepresentable dismisses itself through UIKit.

WHY THIS IS A GUARD AND NOT A STYLE NOTE.

A `UIViewControllerRepresentable` hosted in a `.sheet` is presented BY SwiftUI.
When its coordinator calls `controller.dismiss(animated:)`, the controller goes
away but the `.sheet` binding that presented it is never updated — SwiftUI still
believes its sheet is up. The next presentation change on that view then acts on
a stale belief and dismisses the wrong thing.

WHAT THAT COST (US-2926). PhotoLibraryPicker's coordinator called
`picker.dismiss(animated: true)`. A photo picked from the LIBRARY left Snap-to-
Value and Prospect in that desynced state; the first state change after the pick
was the submit button setting `isLoading`, and the module closed instead. The
network call was never made, so nothing appeared in the edge log, nothing
appeared in Sentry, and it read as "the module is broken on submit".

CameraPicker had always used `@Environment(\.dismiss)` and had never had the
bug. A camera photo submitted fine and the same item from the library did not —
that asymmetry is what isolated it, after three wrong theories.

THE RULE. Take `@Environment(\.dismiss)` in the representable, hand it to the
coordinator as a closure, and call that. SwiftUI then owns the dismissal and the
binding stays true.

Scans only files that declare a representable, and only flags a `.dismiss(` that
is UIKit's — a bare `dismiss()` closure call is the fix, not the defect.
"""

import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOTS = ["GradeThread", "Shared", "ShareExtension", "GradeThreadWidget"]
REPRESENTABLE = re.compile(r":\s*UIViewControllerRepresentable\b")
# `something.dismiss(animated:` — a receiver, a dot, and UIKit's signature.
# A bare `dismiss()` (the SwiftUI closure) has no receiver and no `animated:`.
UIKIT_DISMISS = re.compile(r"\b(\w+)\.dismiss\s*\(\s*animated\s*:")


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    failures = []
    scanned = 0
    for top in ROOTS:
        for dirpath, _, files in os.walk(top):
            for name in files:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name).replace("\\", "/")
                text = open(path, encoding="utf-8").read()
                if not REPRESENTABLE.search(text):
                    continue
                scanned += 1
                for i, line in enumerate(text.split("\n"), 1):
                    # Comments are stripped FIRST, and that is not a detail:
                    # the first version of this guard failed on its own
                    # docstring, which quotes the call it forbids. A guard that
                    # cannot tell code from the documentation about the code
                    # fails on the part most likely to be written.
                    code = line.split("//", 1)[0]
                    if not code.strip():
                        continue
                    if UIKIT_DISMISS.search(code):
                        failures.append(f"{path}:{i}: {line.strip()}")

    if failures:
        print("UIViewControllerRepresentable dismissing itself through UIKit:\n")
        for f in failures:
            print(f"  {f}")
        print(
            "\nSwiftUI presented it, so SwiftUI must dismiss it. Take "
            "@Environment(.dismiss) in the representable, pass it to the "
            "coordinator as a closure, and call that instead. CameraPicker.swift "
            "is the reference shape."
        )
        return 1
    print(
        f"no-uikit-self-dismiss: {scanned} representable(s), none dismiss "
        f"themselves through UIKit"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
