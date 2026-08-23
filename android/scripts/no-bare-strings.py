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
#
# US-2368: this list covers every Compose file under app/src/main. The last two
# in were consignment/ConsignorPicker.kt and marketplaces/ListingCard.kt, held
# back for a while because their copy lived in plain non-composable functions
# that unit tests asserted on by exact wording. Those functions now return the
# DECISION (a sealed hint, a @StringRes id) and a @Composable wrapper resolves
# it, so the tests assert a resource instead of English and stopped being a
# reason not to translate.
SCOPE = [
    "onboarding/OnboardingHost.kt",
    "referrals/ReferralsScreen.kt",
    "support/SupportScreen.kt",
    "support/SupportThreadScreen.kt",
    "feedback/FeedbackSheet.kt",
    "workspace/WorkspaceSwitcherRow.kt",
    "workspace/TeamScreen.kt",
    "autolister/AutolisterSessionScreen.kt",
    "importer/ImportScreen.kt",
    "auth/AuthScreen.kt",
    "home/HomeScreen.kt",
    "money/MoneyScreen.kt",
    "settings/SettingsScreen.kt",
    "snap/SnapScreen.kt",
    "analytics/AnalyticsScreen.kt",
    "automations/AutomationsScreen.kt",
    "autolister/DraftsLibraryScreen.kt",
    "marketplaces/negotiation/NegotiationInboxScreen.kt",
    "templates/TemplatesScreen.kt",
    "marketplaces/MarketplacesScreen.kt",
    "marketplaces/reconciliation/ReconciliationScreen.kt",
    "marketplaces/publish/PublishSheet.kt",
    "pricing/RepricingScreen.kt",
    "inventory/DetailsIntakeScreen.kt",
    "ui/shell/ToolsScreen.kt",
    "scout/ProspectScreen.kt",
    "inventory/ItemCanvasScreen.kt",
    "grading/GradeRequestScreen.kt",
    "ai/AiFillReviewSheet.kt",
    "grading/GradeReportScreen.kt",
    "consignment/ConsignorsScreen.kt",
    "marketplaces/postsale/PostSaleScreen.kt",
    "marketplaces/postsale/EbayCasesScreen.kt",
    "marketplaces/ListingEditSheet.kt",
    "money/InventoryEquityCard.kt",
    "radar/MyStoresScreen.kt",
    "radar/RadarNearbyScreen.kt",
    "radar/RadarVenueDetailScreen.kt",
    "grading/BulkGradeScreen.kt",
    "inventory/InventoryListScreen.kt",
    "marketplaces/promotions/PromotionSheet.kt",
    "analytics/CommunityInsightsScreen.kt",
    "inventory/ItemPhotosSection.kt",
    "inventory/GlobalSearchScreen.kt",
    "disclosure/DisclosureScreen.kt",
    "scout/ScoutScreen.kt",
    "marketplaces/pricing/BulkPricingScreen.kt",
    "consignment/ConsignorPicker.kt",
    "marketplaces/ListingCard.kt",
    "money/SalesScreen.kt",
    "inventory/CompsSection.kt",
    "analytics/ListingPerformanceScreen.kt",
    "grading/DisputeSheet.kt",
    "passport/PassportScreen.kt",
    "billing/PaywallScreen.kt",
    "fulfillment/FulfillmentScreen.kt",
    "inventory/MeasurementsSection.kt",
    "verified/VerifiedScreen.kt",
    "money/PayoutReconciliationScreen.kt",
    "inventory/BulkActionBar.kt",
    "consignment/ConsignmentReportScreen.kt",
    "inventory/AspectsSection.kt",
    "ai/AiExtractScreen.kt",
    "billing/CreditPackSheet.kt",
    "inventory/InventoryFilterSheet.kt",
    "marketplaces/publish/SpecificsSection.kt",
    "billing/PlanStepHost.kt",
    "grading/GradesListScreen.kt",
    "money/ExpenseFormSheet.kt",
    "ui/shell/AppShell.kt",
    "auth/TurnstileChallenge.kt",
    "platform/HapticFeedback.kt",
    "platform/locale/LanguagePicker.kt",
    "platform/applock/LockScreen.kt",
    "ui/a11y/A11yAnnounce.kt",
    "ui/a11y/ReducedMotion.kt",
    "ui/a11y/ScaledIcon.kt",
    "ui/components/CachedThumbnail.kt",
    "ui/components/Charts.kt",
    "ui/components/DataRow.kt",
    "ui/components/ErrorStateView.kt",
    "ui/components/FieldValidation.kt",
    "ui/components/ImeActionBar.kt",
    "ui/components/InfoCard.kt",
    "ui/components/LabeledDropdown.kt",
    "ui/components/Skeleton.kt",
    "ui/components/StatusBadge.kt",
    "ui/shell/SyncStatusBar.kt",
    "ui/theme/Components.kt",
    "ui/theme/Theme.kt",
    "capture/BarcodeScanScreen.kt",
    "capture/CaptureScreen.kt",
    "intake/ShareTargetActivity.kt",
    "inventory/NotesFieldWithDictation.kt",
    "inventory/SkuFieldWithScanner.kt",
    "marketplaces/reconciliation/ReconcileBanner.kt",
    "plangate/PlanGateHost.kt",
    "widget/SellerSnapshotWidget.kt",
]

# The opening of a call/argument that renders or speaks whatever it is given.
# Deliberately does NOT require a quote after it — see _argument_literals for
# why matching the literal's position was a losing game.
SINK_OPENER = re.compile(
    r"""
    (?:
        \bText\s*\(
      | contentDescription\s*=\s*
      | \btext\s*=\s*
      | \blabel\s*=\s*
      | placeholder\s*=\s*
      | announceForAccessibility\s*\(
      | \btitle\s*=\s*
      | \bsubtitle\s*=\s*
      | \bdescription\s*=\s*
      | SectionHeader\s*\(
      | SectionLabel\s*\(
      | Panel(?:Header)?\s*\(
      | InfoCard\s*\(
      | \bHint\s*\(
      | \bBadge\s*\(
      | SectionPlaceholder\s*\(
      | NumberField\s*\(
      | \bField\s*\(
    )
    """,
    re.VERBOSE,
)

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
      | \bHint\s*\(\s*"
      | \bBadge\s*\(\s*"
      | SectionPlaceholder\s*\(\s*"
      | NumberField\s*\(\s*"
      | \bField\s*\(\s*"
    )
    """,
    re.VERBOSE,
)

# The escape hatch, for the one case a rule genuinely cannot judge: a default
# argument holding a WIRE value rather than copy — `surface: String = "single"`
# on a funnel tag. No pattern separates that from `title: String = "Save"`, and
# guessing from the literal's shape ("single" has no spaces, but neither does
# "Save") would be a rule that is wrong in both directions. So it is declared,
# on the line or the line above, and a reviewer sees the claim in the diff.
SUPPRESSION = re.compile(r"no-bare-strings:\s*\S")

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

# Compose animation `label` arguments are DEBUG names — they show up in the
# animation inspector and nowhere else, so translating "skeletonSweep" would be
# nonsense. They collide with the `label = "…"` sink, which is a real sink for
# this app's own components (StatCard(label = "Sold today")), so the two are told
# apart by what call encloses them rather than by the literal's shape: "Pending"
# and "skeleton" look equally translatable in isolation. The look-back is bounded
# and deliberately errs toward exempting — a false exempt loses one string, while
# a false positive on every animation in the app gets the guard switched off.
ANIMATION_CALL = re.compile(
    r"\b(?:rememberInfiniteTransition|updateTransition|rememberTransition"
    r"|animate[A-Za-z]*(?:AsState)?|animatedVectorResource)\s*\("
)
ANIMATION_LOOKBACK = 8

# `if (…) {` / `when (…) {` / `when {` as the argument to a UI sink.
BRANCH_OPENER = re.compile(r"^(?:if\s*\(|when\s*[({])")
BRANCH_SCAN_LIMIT = 40
ARGUMENT_SCAN_LIMIT = 40

# The same branch, but opened on the SAME line as the sink:
# `Text(if (refreshing) "Refreshing…" else "Refresh")`. The wrapped form above
# only fires when the sink ends the line, so this shape — which ktlint leaves
# alone because it fits in 100 columns — slipped past every rule in the file.
SAME_LINE_BRANCH = re.compile(
    r"""
    (?:
        \bText\s*\(
      | contentDescription\s*=\s*
      | \btext\s*=\s*
      | \blabel\s*=\s*
      | \btitle\s*=\s*
      | \bsubtitle\s*=\s*
      | \bdescription\s*=\s*
    )
    (?:if\s*\(|when\s*[({])
    """,
    re.VERBOSE,
)

# An empty or whitespace-only literal is a spacer, not copy. A literal that is
# nothing but a number-format specifier is not copy either — "%.1f" has no words
# in it to translate, and moving it to a resource only invites a translator to
# edit a format string.
TRIVIAL = re.compile(r'"\s*"|"%[-+ 0,#]*[\d.]*[a-zA-Z]"')

# Kotlin string-template holes: "$it", "${state.count}". Removed before judging a
# literal, because the words around them are what a translator sees.
INTERPOLATION = re.compile(r"\$\{[^}]*\}|\$\w+")


def looks_like_copy(literal):
    """Is this literal a sentence a translator should see, or a value?

    Scanning a sink's whole argument (see _argument_literals) means the scan runs
    into separators, wire values and `when` keys as well as copy — `" \u00b7 "`,
    `"capture/photos"`, `"round99"`, `"${'$'}{a.length} / ${'$'}{MAX}"`. Position cannot
    tell those apart from copy, so the literal itself has to.

    Three signals, and a literal needs one of them:
      • internal whitespace between words — "Any time", "cost ${'$'}it"
      • an initial CAPITAL — "Refresh", "SKU", "YYYY-MM-DD"
      • a TEMPLATE HOLE with words around it and no path punctuation —
        "${'$'}selectedCount selected". Without this one, a sentence whose only word
        follows the hole reads as a lowercase single token and slips through;
        that is exactly how BulkActionBar's "N selected" survived. The `/ _ . :`
        exclusion keeps built routes and keys out ("item/${'$'}id", "grade_${'$'}id").

    Which makes the excluded set the lowercase-single-token one: identifiers,
    slugs, enum keys, MIME types, animation labels. The known false negative is
    genuinely lowercase one-word copy with no hole (`Text("ok")`); that is rarer
    than the false positives the previous, positional rule produced, and a false
    positive is what gets a guard switched off.
    """
    raw = literal.strip('"')
    body = INTERPOLATION.sub("", raw)
    if not re.search(r"[A-Za-z]{2,}", body):
        return False
    if re.search(r"[A-Za-z]\s+\S", body.strip()):
        return True
    first = next((c for c in body if c.isalpha()), "")
    if first.isupper():
        return True
    return bool(INTERPOLATION.search(raw)) and not re.search(r"[/_.:]", body)

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
      | \bHint\s*\($
      | \bBadge\s*\($
      | SectionPlaceholder\s*\($
      | NumberField\s*\($
      | \bField\s*\($
    )
    """,
    re.VERBOSE,
)


# A DEFAULT ARGUMENT carrying copy: `title: String = "Couldn't load"`.
#
# The second guard hole, and the same shape as the wrapped-sink one. A shared
# component's default is the copy that actually ships — ErrorStateView's
# "Couldn't load" and "Try again" render on every data screen in the app — but it
# reaches the user through the caller's `Text(title)`, never through a literal at
# a sink, so every sink rule in this file was blind to it. Compose evaluates a
# @Composable function's default expressions in composable context, so the fix is
# just `= stringResource(R.string.…)`; there is no reason to leave these behind.
DEFAULT_ARG_COPY = re.compile(r':\s*String\??\s*=\s*"')

# @Preview bodies are developer scaffolding — they never ship, and their sample
# copy ("Sold price", "$128.00") is the point. Exempting them by REGION rather
# than by line keeps a preview from having to be written differently.
PREVIEW_ANNOTATION = re.compile(r"^\s*@Preview\b")


def preview_lines(lines):
    """Line indices (0-based) inside a @Preview-annotated function body."""
    inside = set()
    for i, line in enumerate(lines):
        if not PREVIEW_ANNOTATION.match(line):
            continue
        # Walk to the body's opening brace, then brace-match to its close.
        # Braces inside string literals are stripped first so a preview holding
        # `"${'$'}{x}"` cannot unbalance the count.
        depth = 0
        started = False
        for j in range(i, len(lines)):
            bare = re.sub(r'"(?:\\.|[^"\\])*"', "", lines[j])
            for ch in bare:
                if ch == "{":
                    depth += 1
                    started = True
                elif ch == "}":
                    depth -= 1
            inside.add(j)
            if started and depth <= 0:
                break
    return inside


def _in_animation_call(lines, index):
    """True when line `index` sits inside an animation call's argument list."""
    start = max(0, index - ANIMATION_LOOKBACK)
    return any(ANIMATION_CALL.search(lines[j]) for j in range(start, index + 1))


def scan(path):
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    skip = preview_lines(lines)
    offenders = []
    # A line can sit inside two nested sinks (`label = { Text(…) }`), so hits are
    # deduped on line number — one offender per line, not one per enclosing call.
    seen = set()
    for i, line in enumerate(lines):
        if i in skip:
            continue
        if EXEMPT.search(line):
            continue
        if SUPPRESSION.search(line) or (i and SUPPRESSION.search(lines[i - 1])):
            continue
        default_arg = DEFAULT_ARG_COPY.search(line)
        if default_arg:
            tail = line[default_arg.end() - 1:]
            literal = re.match(r'"(?:\\.|[^"\\])*"', tail)
            if literal and not TRIVIAL.match(tail) and looks_like_copy(literal.group()):
                offenders.append((i + 1, line.strip()))
                continue
        opener = SINK_OPENER.search(line)
        if not opener:
            continue
        if opener.group().lstrip().startswith("label") and _in_animation_call(lines, i):
            continue
        for hit in _argument_literals(lines, i, opener.end(), skip):
            if hit[0] not in seen:
                seen.add(hit[0])
                offenders.append(hit)
    return sorted(offenders)


def _argument_literals(lines, index, from_column, skip):
    """Non-trivial string literals inside the sink's argument list.

    Scanning the WHOLE argument rather than pattern-matching its shape is the
    fourth revision of this rule, and the reason is that every earlier one lost
    to ordinary Kotlin. First it read only `Text("x")`. Then ktlint's wrapped
    form. Then `if (…) { … } else { … }`. Then the same conditional written on
    one line. `Text(band.days?.let { "Last $it days" } ?: "Any time")` would have
    been the fifth. There is no finite list of expression shapes copy can hide
    in, so the rule stops enumerating them: find the argument list, read to its
    close, and flag any literal that is not trivial.
    """
    found = []
    depth = 1
    for j in range(index, min(len(lines), index + ARGUMENT_SCAN_LIMIT)):
        if j in skip:
            break
        segment = lines[j][from_column:] if j == index else lines[j]
        stripped = lines[j].strip()
        commented = stripped.startswith(("//", "*", "/*"))
        if not commented and not EXEMPT.search(lines[j]) and not SUPPRESSION.search(lines[j]):
            for lit in re.finditer(r'"(?:\\.|[^"\\])*"', segment):
                if not TRIVIAL.match(lit.group()) and looks_like_copy(lit.group()):
                    found.append((j + 1, stripped))
                    break
        if commented:
            continue
        bare = re.sub(r'"(?:\\.|[^"\\])*"', "", segment)
        bare = re.sub(r"//.*", "", bare)
        for ch in bare:
            if ch in "{(":
                depth += 1
            elif ch in "})":
                depth -= 1
                if depth <= 0:
                    return found
    return found


def _branch_literals(lines, index, from_column=0):
    """String literals inside the if/when expression starting at `index`.

    `from_column` is where the branch keyword sits on the opening line — 0 for
    the wrapped form (`Text(` then `if (…)` on the next line), and the sink's end
    for the same-line form (`Text(if (…) "a" else "b")`). Literals are matched
    ANYWHERE on a line, not only at its start: a branch puts them after the
    condition, and a start-of-line rule reads that as clean.
    """
    found = []
    depth = 0
    started = False
    for j in range(index, min(len(lines), index + BRANCH_SCAN_LIMIT)):
        segment = lines[j][from_column:] if j == index else lines[j]
        bare = re.sub(r'"(?:\\.|[^"\\])*"', "", segment)
        for ch in bare:
            if ch in "{(":
                depth += 1
                started = True
            elif ch in "})":
                depth -= 1
        stripped = lines[j].strip()
        if not stripped.startswith(("//", "*", "/*")):
            for lit in re.finditer(r'"(?:\\.|[^"\\])*"', segment):
                if not TRIVIAL.match(lit.group()):
                    found.append((j + 1, stripped))
                    break
        if started and depth <= 0:
            break
    return found


# Each case is (name, source, should_flag). A guard with three new rules and no
# test is a guard nobody can tell is working — the repo has already shipped two
# rules that silently matched nothing, so every rule here has to prove it fires
# AND prove it stays quiet on the shape it must not flag.
SELF_TESTS = [
    (
        "sink on one line",
        'Text("Save")',
        True,
    ),
    (
        "sink with the literal wrapped onto the next line",
        'Text(\n    "Save",\n)',
        True,
    ),
    (
        "copy in a default argument",
        'fun X(\n    title: String = "Couldn\'t load",\n)',
        True,
    ),
    (
        "a nullable-String default carrying copy",
        'fun X(\n    hint: String? = "Try again",\n)',
        True,
    ),
    (
        "conditional copy inside a sink",
        'Text(\n    if (over) {\n        "Too many photos."\n    } else {\n        "Pick one."\n    },\n)',
        True,
    ),
    (
        "a resource default is fine",
        'fun X(\n    title: String = stringResource(R.string.x),\n)',
        False,
    ),
    (
        "an animation label is a debug name, not copy",
        'val t = rememberInfiniteTransition(label = "skeleton")',
        False,
    ),
    (
        "a wrapped animation label is still a debug name",
        'val a = t.animateFloat(\n    initialValue = 0f,\n    label = "skeletonSweep",\n)',
        False,
    ),
    (
        "a preview body may hold sample copy",
        '@Preview\n@Composable\nprivate fun P() {\n    Text("Sold price")\n}',
        False,
    ),
    (
        "a bare format specifier is not copy",
        'Text("%.1f")',
        False,
    ),
    (
        "a conditional opened on the same line as the sink",
        'Text(if (refreshing) "Refreshing\u2026" else "Refresh")',
        True,
    ),
    (
        "a same-line conditional of non-literals is fine",
        "Text(if (refreshing) state.a else state.b)",
        False,
    ),
    (
        "a wrapped branch with the literal after the condition",
        'Text(\n    if (done) "Done $x" else x,\n)',
        True,
    ),
    (
        "an elvis inside a sink — the shape that killed the positional rule",
        'Text(band.days?.let { "Last $it days" } ?: "Any time")',
        True,
    ),
    (
        "a sentence whose only word trails a template hole",
        'Text("$selectedCount selected")',
        True,
    ),
    (
        "a route built from a template hole is not copy",
        'Text(nav.go("item/$id"))',
        False,
    ),
    (
        "a joinToString separator is not copy",
        'Text(parts.joinToString(" \u00b7 "))',
        False,
    ),
    (
        "a when key inside a sink is not copy",
        'Text(\n    when (mode) {\n        "round99" -> a\n        else -> b\n    },\n)',
        False,
    ),
    (
        "a route handed to a callback is not copy",
        'Button(text = stringResource(R.string.go)) { onPick("capture/photos") }',
        False,
    ),
    (
        "a counter built only from interpolations is not copy",
        'Text(state.error ?: "${state.body.length} / ${MAX}")',
        False,
    ),
    (
        "a comment inside a branch is not copy",
        'Text(\n    if (a) {\n        // says "hello" in a comment\n        x\n    } else {\n        y\n    },\n)',
        False,
    ),
    (
        "a declared wire value is exempt",
        'fun X(\n    // no-bare-strings: wire value\n    heading: String = "Pick a plan",\n)',
        False,
    ),
    (
        "an undeclared copy default is still flagged",
        'fun X(\n    heading: String = "Pick a plan",\n)',
        True,
    ),
    (
        "a conditional of non-literals is fine",
        'Text(\n    if (over) {\n        stringResource(R.string.a)\n    } else {\n        row.detail\n    },\n)',
        False,
    ),
]


def self_test():
    import tempfile

    failures = []
    for name, source, should_flag in SELF_TESTS:
        with tempfile.NamedTemporaryFile("w", suffix=".kt", delete=False, encoding="utf-8") as fh:
            fh.write(source + "\n")
            path = fh.name
        try:
            flagged = bool(scan(path))
        finally:
            os.unlink(path)
        if flagged != should_flag:
            failures.append(
                f"  {name}: expected {'a hit' if should_flag else 'no hit'}, got the opposite"
            )
    if failures:
        print("no-bare-strings --self-test FAILED", file=sys.stderr)
        for line in failures:
            print(line, file=sys.stderr)
        return 1
    print(f"no-bare-strings: self-test OK ({len(SELF_TESTS)} cases)")
    return 0


def main():
    if "--self-test" in sys.argv:
        return self_test()

    # The self-test runs on EVERY invocation, not just behind the flag. It costs
    # milliseconds, and wiring a second command into CI is a step someone has to
    # remember — a guard whose own test is opt-in is back where it started.
    if self_test() != 0:
        return 1

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
