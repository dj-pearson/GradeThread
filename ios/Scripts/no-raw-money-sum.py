#!/usr/bin/env python3
"""Fail if app sources accumulate a currency amount without ``Money.sum``.

WHY
---
Currency is stored and sent as `Double`, and `24.99` is really `24.9899999...`.
One value is fine; a SUM of many compounds the error past a cent. US-790 added
`Money.sum` / `Money.sumDecimal` (ios/Packages/GradeThreadCore/.../MoneyMath.swift)
so every rollup converts to an exact 2-dp `Decimal`, sums there, and comes back
cents-rounded.

That rule then lived only in MoneyMath's own header, where no call site could
be affected by it. Four sums were added afterwards that never got the memo:
the drafts library's "list value", the fulfillment queue's total label cost,
`SalesStore.totalProceeds`, and the average net profit behind the graded-vs-
ungraded ROI buckets. Each is a number a seller can add up by hand from the
rows shown right next to it, which is exactly where an off-by-a-cent total gets
noticed and believed.

WHAT IT CATCHES
---------------
`reduce(0` / `reduce(0.0` / `reduce(Double(` whose line mentions a money word
(price, amount, cost, fee, proceeds, profit, revenue, payout, net, ...). That
is deliberately a line-level heuristic, not a type check: it is cheap, it runs
in the fast lane with the other twelve guards, and the fix is always the same
one-line swap. A genuine non-money sum that trips it goes in ALLOWED with a
reason, the same way the other guards handle their exceptions.

NOT CAUGHT (and fine): `+` on two amounts, `-` for a single subtraction, and
`/ Double(count)` for an average. Only ACCUMULATION drifts.
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _scan_scope import TARGET_DIRS as SCAN_DIRS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# `reduce` seeded with a numeric zero. `reduce(into:` and `reduce(Decimal.zero`
# are not accumulation-in-Double and are not matched.
REDUCE_RE = re.compile(r"\.reduce\(\s*(?:0\.0|0|Double\(\s*0\s*\))\s*[,)]")

# Money words, as whole words inside an identifier boundary. `netCount` is not
# money; `net` and `netProfit` are — so the match is on the word, allowing a
# camelCase continuation.
MONEY_WORDS = [
    "price", "prices", "amount", "amounts", "cost", "costs", "fee", "fees",
    "proceeds", "profit", "revenue", "payout", "payouts", "net", "nets",
    "subtotal", "total", "totals", "spend", "spent", "value", "cents",
    "dollars", "shipping", "refund", "refunds", "basis", "equity", "balance",
]
# Matched at a camelCase boundary, and NOT case-insensitively: `re.IGNORECASE`
# would make the trailing `[a-z]` match `L` too, so `totalLabelCost` stopped
# matching `total` and the whole gate passed against code it was written for.
# Two forms per word instead: the lowercase one after a non-letter
# (`totalLabelCost`, `.shippingCost`), and the capitalized one anywhere
# (`labelCost`). Both refuse a lowercase continuation, so `network` is not
# `net` and `Netflix` is not `Net`.
MONEY_RE = re.compile(
    "|".join(
        [r"(?<![A-Za-z])" + w + r"(?![a-z])" for w in MONEY_WORDS]
        + [w.capitalize() + r"(?![a-z])" for w in MONEY_WORDS]
    )
)

# Every entry names WHY the sum is not currency. An entry that stops matching is
# not an error here (unlike a UI-check knownNoise) because these are file:line
# pairs that move; the reason text is the point — it must stay true.
ALLOWED = {
    # Counts and ratios, not money.
    "GradeThread/AIExtract/AIFillReview.swift": "counts filled aspects",
    "GradeThread/AutoLister/AutoListerReviewModel.swift": "counts grouped windows",
    "GradeThread/Prospect/RadarScoring.swift": "sums item COUNTS for a share weight",
    "GradeThread/Upload/PhotoUploadStore.swift": "counts active upload tasks",
    "GradeThread/AIExtract/AIExtractionManager.swift": "counts uploaded photos",
    "GradeThread/Capture/TagPhotoQuality.swift": "sums characters in OCR lines",
    # Grades are a 1.0-10.0 scale, not currency: they are averaged, never
    # accumulated into a figure anyone reconciles, and MoneyMath's 2-dp cents
    # rounding is the wrong rounding for a scale that displays 1 decimal.
    "GradeThread/Analytics/AnalyticsMetrics.swift": "grade average (line 145) is a 1-10 scale",
    "GradeThread/Dashboard/DashboardView.swift": "average GRADE, not money",
    "GradeThread/Grading/GradesListView.swift": "average GRADE, not money",
    # Percentages and day-spans.
    "GradeThread/Analytics/AnalyticsView.swift": "sell-through counts and percentage lifts",
    "GradeThread/Money/MoneyAnalyticsRollup.swift": "averages a span in DAYS",
    # Already exact: sums tenths-of-a-mile as Int.
    "GradeThread/Money/MileageStore.swift": "sums integer tenths of a mile",
}

# The sanctioned implementation sums in Decimal — it is what everyone else calls.
IMPLEMENTATION = "Packages/GradeThreadCore/Sources/GradeThreadCore/MoneyMath.swift"


def main() -> int:
    violations: list[str] = []
    scanned = 0

    for rel_dir in SCAN_DIRS:
        base = os.path.join(ROOT, rel_dir)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in filenames:
                if not name.endswith(".swift"):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
                if "Tests" in rel or rel == IMPLEMENTATION:
                    continue
                scanned += 1
                if rel in ALLOWED:
                    continue
                with open(path, encoding="utf-8") as handle:
                    for num, line in enumerate(handle, 1):
                        stripped = line.strip()
                        if stripped.startswith("//") or stripped.startswith("///"):
                            continue
                        if REDUCE_RE.search(line) and MONEY_RE.search(line):
                            violations.append(f"{rel}:{num}: {stripped}")

    # A gate that scans nothing passes forever. Fail loudly instead.
    if scanned < 50:
        print(
            f"ERROR: only {scanned} Swift files scanned - the layout changed and "
            "this gate is no longer looking at the app. Fix the paths.",
            file=sys.stderr,
        )
        return 2

    if violations:
        print("ERROR: currency accumulated with a raw reduce:", file=sys.stderr)
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print(
            "\nUse `Money.sum(items) { $0.amount }` (or `Money.sum(amounts)` / "
            "`Money.sumDecimal`) from GradeThreadCore. It sums in exact Decimal "
            "so a few hundred rows can't drift past a cent (US-790). If the sum "
            "genuinely isn't currency, add the file to ALLOWED in this script "
            "with the reason.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: every currency rollup goes through Money.sum ({scanned} files).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
