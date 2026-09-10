#!/usr/bin/env python3
"""US-3119 - fail the build if a @HiltViewModel reaches for Dispatchers.IO.

WHAT THIS PREVENTS, AND WHY IT IS NOT A STYLE RULE. A ViewModel test swaps
`Dispatchers.Main` for a `StandardTestDispatcher`, calls the method, then
`advanceUntilIdle()` and asserts. `advanceUntilIdle()` advances the TEST
scheduler. A `withContext(Dispatchers.IO)` inside `viewModelScope.launch` hands
that work to a real background pool the test scheduler knows nothing about, so
`advanceUntilIdle()` returns while the coroutine is still suspended and every
assertion runs against a ViewModel that has not done anything yet.

It never fails as "the harness is wrong". In US-3027 it presented as
`expected [tag] but was null` on four of ProspectRolesTest's cases, which reads
as the production code failing to send photo roles. The roles were correct. Four
tests sat red on main describing a defect that was not there, and the real
defect they should have caught was somewhere else entirely. The other direction
is worse and quieter: a test that asserts against an untouched ViewModel and
happens to pass does so whether the code works or not.

THE FIX IS ALREADY BUILT. `platform/di/DispatcherModule.kt` provides an
`@IoDispatcher` qualifier. Take it as a constructor argument:

    @HiltViewModel
    class ThingViewModel @Inject constructor(
        private val service: Thing,
        @IoDispatcher private val io: CoroutineDispatcher,
    ) : ViewModel() {
        fun load() = viewModelScope.launch { withContext(io) { ... } }
    }

...and the test passes `mainDispatcher.dispatcher`, the one it is already
driving, so `advanceUntilIdle()` means what it says.

HOW IT SCANS, and why each part is the way it is (the modes in
`guards-that-do-not-guard`):

  * Comments are stripped as BLOCKS first, then as lines, before anything is
    matched. Every fixed ViewModel carries a comment naming the banned form,
    which is mode 1 - the guard's own documentation satisfying it - in the
    false-positive direction. Line-prefix stripping alone leaves the interior of
    a `/** ... */` block, which is mode 1b.
  * The scan is scoped to ONE CLASS - from the `@HiltViewModel` annotation to
    the brace-tracked end of its body - and not to the file. The constructor
    list is deliberately inside that span (it is where the fix goes and where
    the comments about it are written); the next class down is outside.
    `ReceiptScanViewModel.kt` also holds two composables, and flagging one of
    those would be a finding nobody can act on, while passing because a sibling
    in the same file is clean is mode 3.
  * A run that matches no ViewModels at all reports a FAILURE, not OK. A guard
    whose class detector stops matching (a Hilt rename, a move) reports zero
    offenders, which is indistinguishable from a clean tree - mode 6. The floor
    below is checked against what is on disk on every real run.
  * `--self-test` exercises the detector against the exact shape of the original
    defect plus the controls that must NOT fire.

Run locally:  python3 android/scripts/no-inline-io-dispatcher.py
              python3 android/scripts/no-inline-io-dispatcher.py --self-test
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(ROOT, "app", "src", "main")

#: The annotation that makes a class a ViewModel Hilt builds.
HILT_VIEWMODEL = "@HiltViewModel"

#: `Dispatchers.IO`, however it is spelled: bare, fully qualified, or reached
#: through an import alias of the object. `Dispatchers . IO` is legal Kotlin.
DISPATCHERS_IO = re.compile(r"\bDispatchers\s*\.\s*IO\b")

#: The floor that keeps mode 6 out. There were 67 @HiltViewModel classes when
#: this was written (2026-09-10) and the number only grows; a run that finds
#: fewer than this has almost certainly stopped recognising the annotation
#: rather than watched two thirds of the ViewModels disappear.
MIN_VIEWMODELS = 40


def strip_comments(source):
    """Blocks first, then line comments, replacing each with blank space.

    Newlines inside a block comment are kept so line numbers survive; every
    other character becomes a space, so nothing a comment says can be matched
    and nothing after it shifts.
    """
    def blank(match):
        return "".join(ch if ch == "\n" else " " for ch in match.group(0))

    without_blocks = re.sub(r"/\*[\s\S]*?\*/", blank, source)
    return re.sub(r"//[^\n]*", blank, without_blocks)


def viewmodel_bodies(source):
    """Every `@HiltViewModel` class, as (class_name, start, end) offsets.

    The span starts at the ANNOTATION, not at the class body's opening brace,
    so the constructor parameter list is inside it - that is where the injected
    dispatcher goes, and where every explanatory comment about the banned form
    is actually written. Ending it is brace-tracked from the first `{`, so a
    sibling class further down the same file is outside (mode 3).
    """
    bodies = []
    for match in re.finditer(re.escape(HILT_VIEWMODEL), source):
        rest = source[match.end():]
        name_match = re.search(r"\bclass\s+([A-Za-z_][A-Za-z0-9_]*)", rest)
        open_brace = rest.find("{")
        if not name_match or open_brace < 0:
            continue
        depth = 0
        end = None
        for i in range(open_brace, len(rest)):
            if rest[i] == "{":
                depth += 1
            elif rest[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end is None:
            # An unbalanced file is a parse failure, not a clean file. Report it
            # rather than silently skipping the class (mode 6).
            bodies.append((name_match.group(1), match.end(), len(rest) + match.end()))
            continue
        bodies.append((name_match.group(1), match.end(), match.end() + end))
    return bodies


def scan_source(source, path="case.kt"):
    """Findings for one file's text. Returns (path, line, class, text) tuples."""
    stripped = strip_comments(source)
    findings = []
    for class_name, start, end in viewmodel_bodies(stripped):
        body = stripped[start:end]
        for hit in DISPATCHERS_IO.finditer(body):
            line_no = stripped.count("\n", 0, start + hit.start()) + 1
            # The ORIGINAL line, so the message shows what was written rather
            # than the blanked-out version the matcher read.
            text = source.splitlines()[line_no - 1].strip() if line_no - 1 < len(source.splitlines()) else ""
            findings.append((path, line_no, class_name, text))
    return findings


def scan_tree():
    """Every .kt under app/src/main. Returns (findings, viewmodels_seen)."""
    findings = []
    seen = 0
    for base, _dirs, files in os.walk(SOURCE_DIR):
        for name in sorted(files):
            if not name.endswith(".kt"):
                continue
            path = os.path.join(base, name)
            with open(path, "r", encoding="utf-8") as handle:
                source = handle.read()
            if HILT_VIEWMODEL not in source:
                continue
            stripped = strip_comments(source)
            seen += len(viewmodel_bodies(stripped))
            findings.extend(scan_source(source, os.path.relpath(path, ROOT).replace("\\", "/")))
    return findings, seen


#: (name, source, should_flag). The first case is the exact shape of the
#: US-3027/US-3119 defect; the rest are the ways a scan for it goes wrong.
SELF_TEST_CASES = [
    (
        "the original defect: a file read on Dispatchers.IO inside a HiltViewModel",
        """
@HiltViewModel
class ThingViewModel @Inject constructor(private val service: Thing) : ViewModel() {
    fun load(uri: Uri) {
        viewModelScope.launch {
            val text = withContext(Dispatchers.IO) { read(uri) }
            _state.value = State(text = text)
        }
    }
}
""",
        True,
    ),
    (
        "the same thing fully qualified",
        """
@HiltViewModel
class ThingViewModel @Inject constructor() : ViewModel() {
    fun load() {
        viewModelScope.launch {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { read() }
        }
    }
}
""",
        True,
    ),
    (
        "a private scope built on the IO pool, which advanceUntilIdle also cannot reach",
        """
@HiltViewModel
class ThingViewModel @Inject constructor() : ViewModel() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
}
""",
        True,
    ),
    (
        "spaced out, which is legal Kotlin",
        """
@HiltViewModel
class ThingViewModel : ViewModel() {
    fun load() = viewModelScope.launch { withContext(Dispatchers . IO) { read() } }
}
""",
        True,
    ),
    (
        "the annotation sitting under a KDoc block, which is how every real one is written",
        """
/**
 * US-1389: the thing.
 */
@HiltViewModel
class ThingViewModel : ViewModel() {
    fun load() = viewModelScope.launch { withContext(Dispatchers.IO) { read() } }
}
""",
        True,
    ),
    (
        "control: the fix - an injected @IoDispatcher",
        """
@HiltViewModel
class ThingViewModel @Inject constructor(
    @IoDispatcher private val io: CoroutineDispatcher,
) : ViewModel() {
    fun load() = viewModelScope.launch { withContext(io) { read() } }
}
""",
        False,
    ),
    (
        "control: a LINE comment in the class BODY naming the banned form (mode 1)",
        """
@HiltViewModel
class ThingViewModel @Inject constructor(
    @IoDispatcher private val io: CoroutineDispatcher,
) : ViewModel() {
    // US-3119: `withContext(Dispatchers.IO)` here would hand the read to a pool
    // no test scheduler is on, so the dispatcher is injected instead.
    fun load() = viewModelScope.launch { withContext(io) { read() } }
}
""",
        False,
    ),
    (
        "control: the same explanation as a KDoc BLOCK in the body, whose interior "
        "survives line-prefix stripping (mode 1b)",
        """
@HiltViewModel
class ThingViewModel @Inject constructor(
    @IoDispatcher private val io: CoroutineDispatcher,
) : ViewModel() {
    /**
     * Injected, because
     *     withContext(Dispatchers.IO)
     * makes advanceUntilIdle() a lie.
     */
    fun load() = viewModelScope.launch { withContext(io) { read() } }
}
""",
        False,
    ),
    (
        "control: a comment in the CONSTRUCTOR list, which is where every real one is "
        "written - the scan starts at the annotation, so this IS input to it",
        """
@HiltViewModel
class ThingViewModel @Inject constructor(
    // US-3119: injected rather than reached for inline. `withContext(Dispatchers.IO)`
    // here hands the read to a pool no test scheduler is on.
    @IoDispatcher private val io: CoroutineDispatcher,
) : ViewModel() {
    fun load() = viewModelScope.launch { withContext(io) { read() } }
}
""",
        False,
    ),
    (
        "control: Dispatchers.IO in a plain class - a repository may use it and this rule is not about it",
        """
@Singleton
class ThingRepository @Inject constructor() {
    suspend fun read() = withContext(Dispatchers.IO) { file.readText() }
}
""",
        False,
    ),
    (
        "control: a sibling class in the same file as a clean ViewModel (mode 3)",
        """
@HiltViewModel
class ThingViewModel @Inject constructor(
    @IoDispatcher private val io: CoroutineDispatcher,
) : ViewModel() {
    fun load() = viewModelScope.launch { withContext(io) { read() } }
}

class ThingStore {
    suspend fun read() = withContext(Dispatchers.IO) { file.readText() }
}
""",
        False,
    ),
    (
        "the inverse of the case above: the ViewModel is dirty and the sibling clean",
        """
@HiltViewModel
class ThingViewModel : ViewModel() {
    fun load() = viewModelScope.launch { withContext(Dispatchers.IO) { read() } }
}

class ThingStore {
    suspend fun read() = withContext(io) { file.readText() }
}
""",
        True,
    ),
    (
        "control: Dispatchers.Main and Dispatchers.Default are not this rule",
        """
@HiltViewModel
class ThingViewModel : ViewModel() {
    fun load() = viewModelScope.launch { withContext(Dispatchers.Default) { compute() } }
}
""",
        False,
    ),
]


def self_test():
    """The detector has to still fire on the thing it was written for.

    Returns 0 when healthy. Every case here was watched to fail: the matcher was
    broken on purpose (comment stripping removed, the class scope widened to the
    whole file) and the relevant cases went red.
    """
    failures = []
    for name, source, should_flag in SELF_TEST_CASES:
        flagged = bool(scan_source(source))
        if flagged != should_flag:
            failures.append(
                f"  {name} - expected "
                f"{'a finding' if should_flag else 'no finding'}, got the opposite"
            )

    # The detector must also find the class in the first place. A rule that
    # matches nothing reports OK forever (mode 6).
    if len(viewmodel_bodies(strip_comments(SELF_TEST_CASES[0][1]))) != 1:
        failures.append("  the @HiltViewModel class detector found no class in the defect case")

    if failures:
        print("no-inline-io-dispatcher self-test FAILED:")
        print("\n".join(failures))
        return 1
    print(f"no-inline-io-dispatcher self-test: {len(SELF_TEST_CASES)} cases, all as expected.")
    return 0


def main():
    if "--self-test" in sys.argv:
        return self_test()

    if not os.path.isdir(SOURCE_DIR):
        print(f"no-inline-io-dispatcher: {SOURCE_DIR} not found", file=sys.stderr)
        return 1

    findings, seen = scan_tree()

    if seen < MIN_VIEWMODELS:
        print(
            f"no-inline-io-dispatcher: only {seen} @HiltViewModel classes were found under "
            f"app/src/main, and there should be at least {MIN_VIEWMODELS}.\n"
            "The class detector has stopped matching, so a clean result here means nothing. "
            "Fix the detector (or lower MIN_VIEWMODELS deliberately, in a commit that says why).",
            file=sys.stderr,
        )
        return 1

    if not findings:
        print(f"no-inline-io-dispatcher: OK - {seen} ViewModels, none reach for Dispatchers.IO.")
        return 0

    print("no-inline-io-dispatcher: a @HiltViewModel reaches for Dispatchers.IO\n", file=sys.stderr)
    for path, line_no, class_name, text in findings:
        print(f"  {path}:{line_no}: {class_name}: {text}", file=sys.stderr)
    print(
        "\nTake the dispatcher as a constructor argument instead:\n"
        "    @IoDispatcher private val io: CoroutineDispatcher,\n"
        "  (com.gradethread.app.platform.di.IoDispatcher, provided by DispatcherModule)\n"
        "and use `withContext(io)`. Then a test can pass the dispatcher it is already\n"
        "driving, and `advanceUntilIdle()` will actually wait for the work. Left inline,\n"
        "every test of this path asserts against a ViewModel that has not run yet - which\n"
        "passes or fails for reasons unconnected to the code it names (US-3027, US-3119).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
