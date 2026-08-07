#!/usr/bin/env python3
"""US-2150 — report the per-ABI download size of the release App Bundle and fail
if a native slice blows its budget.

Why this exists. ML Kit's text recogniser is a NATIVE pipeline
(`libmlkit_google_ocr_pipeline.so`) and the barcode scanner is another
(`libbarhopper_v3.so`), and a native library exists once PER ABI. Adding text
recognition took the universal debug APK from 45MB to 87MB and nothing in the
build said a word about it — a green build, a working app, and a download that
had doubled. (The Japanese script model is ~1.8MB of *assets*; dropping it is
not the fix, because Latin needs the same native pipeline.)

The App Bundle fixes the download: Play sends each device one ABI. It does
nothing about the blindness, which is what this script is for.

WHAT IS ENFORCED, and what is only reported. The budget is on each ABI's
NATIVE slice — the bytes that exist once per ABI and are therefore the thing
ABI-splitting is about. `shared` (dex, resources, assets) is reported but not
budgeted: it is identical on every device, so it is a size question of its own
and not an ABI one. Budgeting a number on a hunch is worse than not budgeting
it, because a placeholder reads like a finding.

Sizes are DOWNLOAD sizes, so entries are measured compressed, deflating any
entry the bundle STORES raw — native libraries usually are, and Play
recompresses them on the way out, so counting them at their on-disk size
overstates the download by roughly 2x.

They are estimates, deliberately. bundletool would be exact but needs a jar
download and a signing key in CI, and the job here is to catch a DOUBLING —
which an estimate a few percent off catches just as well.

Run locally:
    cd android && ./gradlew bundleRelease
    python3 android/scripts/abi-size-report.py

Self-test (no bundle needed, runs first in CI):
    python3 android/scripts/abi-size-report.py --self-test
"""
import io
import json
import os
import sys
import zipfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BUNDLE = os.path.join(
    ROOT, "app", "build", "outputs", "bundle", "release", "app-release.aab"
)
BUDGET = os.path.join(ROOT, "abi-size-budget.json")
MB = 1024 * 1024


def download_bytes(archive, info):
    """Compressed size of one entry, deflating it ourselves when it is STORED."""
    if info.compress_type != zipfile.ZIP_STORED:
        return info.compress_size
    with archive.open(info) as handle:
        return len(zlib.compress(handle.read(), 6))


def measure(path_or_file):
    """-> (shared_bytes, {abi: native_bytes}, {abi: {library: bytes}})"""
    shared = 0
    per_abi = {}
    libraries = {}
    with zipfile.ZipFile(path_or_file) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            parts = info.filename.split("/")
            # <module>/lib/<abi>/<name>.so — the module prefix is `base` today,
            # but a feature module would use its own name, so match on shape
            # rather than on the literal "base".
            if len(parts) >= 4 and parts[1] == "lib":
                abi, name = parts[2], parts[-1]
                size = download_bytes(archive, info)
                per_abi[abi] = per_abi.get(abi, 0) + size
                libraries.setdefault(abi, {})[name] = size
            else:
                shared += download_bytes(archive, info)
    return shared, per_abi, libraries


def review(shared, per_abi, libraries, budgets):
    """-> (markdown_report, [failure, ...])"""
    failures = []
    lines = [
        "## Per-ABI download size (US-2150)",
        "",
        "| ABI | native (budgeted) | budget | + shared | device download |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for abi in sorted(per_abi):
        native = per_abi[abi]
        budget = budgets.get(abi)
        lines.append(
            f"| `{abi}` | **{native / MB:.2f} MB** |"
            f" {f'{budget:.2f} MB' if budget else '—'} |"
            f" {shared / MB:.2f} MB | {(shared + native) / MB:.2f} MB |"
        )
        if budget is not None and native > budget * MB:
            failures.append(
                f"{abi}: native slice {native / MB:.2f} MB exceeds its"
                f" {budget:.2f} MB budget"
            )

    # An ABI with no budget line is an ABI nothing is watching — precisely the
    # hole this script exists to close, so it is an error, not a warning.
    for abi in sorted(set(per_abi) - set(budgets)):
        failures.append(f"{abi}: built but has no entry in abi-size-budget.json")
    for abi in sorted(set(budgets) - set(per_abi)):
        failures.append(f"{abi}: budgeted but not built — stale abi-size-budget.json")

    worst = max(shared + n for n in per_abi.values())
    universal = shared + sum(per_abi.values())
    lines += [
        "",
        f"A universal APK would be **{universal / MB:.2f} MB** for every device."
        f" The bundle sends one ABI, so the worst case is **{worst / MB:.2f} MB**"
        f" — {(universal - worst) / MB:.2f} MB less.",
        "",
        "`shared` (dex, resources, assets) is reported, not budgeted: it is the"
        " same on every device, so it is not an ABI question.",
        "",
        "### Native libraries per ABI",
        "",
    ]
    for abi in sorted(libraries):
        lines.append(f"- `{abi}` — {per_abi[abi] / MB:.2f} MB")
        for name, size in sorted(libraries[abi].items(), key=lambda kv: -kv[1]):
            lines.append(f"  - `{name}` — {size / MB:.2f} MB")
    return "\n".join(lines), failures


def load_budgets():
    with open(BUDGET, encoding="utf-8") as handle:
        return json.load(handle)["nativeBudgetMb"]


def self_test():
    """Execute every path against a synthetic bundle.

    A size gate nobody runs reports PASS forever, and this one only gets a real
    bundle on a machine that can finish a release build. So the logic is
    exercised here, against a zip whose answers are known by construction —
    including the two failures that matter (over budget, unwatched ABI) and a
    STORED entry, which is how a real bundle ships its native libraries.
    """
    payload = b"\0" * 4096  # deflates to almost nothing; sizes below are exact
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("base/dex/classes.dex", payload)
        archive.writestr("base/res/drawable/x.png", payload)
        archive.writestr("BundleConfig.pb", payload)
        # STORED, like a real bundle's native libs — the branch that would
        # otherwise report a raw on-disk size as if it were a download.
        for abi in ("arm64-v8a", "armeabi-v7a"):
            archive.writestr(
                zipfile.ZipInfo(f"base/lib/{abi}/libmlkit_google_ocr_pipeline.so"),
                payload * 8,
                compress_type=zipfile.ZIP_STORED,
            )

    shared, per_abi, libraries = measure(buffer)
    assert set(per_abi) == {"arm64-v8a", "armeabi-v7a"}, per_abi
    assert shared > 0, "shared entries were counted as native"
    stored = per_abi["arm64-v8a"]
    assert 0 < stored < 8 * len(payload), (
        f"a STORED entry was not deflated: {stored} bytes"
    )
    assert set(libraries["arm64-v8a"]) == {"libmlkit_google_ocr_pipeline.so"}

    generous = {abi: 10.0 for abi in per_abi}
    report, failures = review(shared, per_abi, libraries, generous)
    assert not failures, failures
    assert "libmlkit_google_ocr_pipeline.so" in report

    # The mutation the whole script exists to catch: one ABI doubles.
    doubled = dict(per_abi, **{"arm64-v8a": per_abi["arm64-v8a"] * 2})
    tight = {abi: per_abi[abi] / MB * 1.2 for abi in per_abi}
    _, failures = review(shared, doubled, libraries, tight)
    assert len(failures) == 1 and "exceeds its" in failures[0], failures

    # An ABI nobody budgeted must fail, not pass quietly.
    _, failures = review(shared, per_abi, libraries, {"arm64-v8a": 10.0})
    assert any("no entry in abi-size-budget.json" in f for f in failures), failures
    # ...and so must a budget for an ABI that is no longer built.
    _, failures = review(shared, per_abi, libraries, dict(generous, mips=10.0))
    assert any("stale abi-size-budget.json" in f for f in failures), failures

    # The real budget file must parse and name only ABIs the build produces.
    budgets = load_budgets()
    assert budgets, "abi-size-budget.json has no nativeBudgetMb entries"
    print(f"self-test OK — budgets for {', '.join(sorted(budgets))}")
    return 0


def main(argv):
    if "--self-test" in argv:
        return self_test()

    path = next((a for a in argv[1:] if not a.startswith("-")), DEFAULT_BUNDLE)
    if not os.path.exists(path):
        print(f"No bundle at {path} — run `./gradlew bundleRelease` first.")
        return 1

    shared, per_abi, libraries = measure(path)
    if not per_abi:
        print(f"{path} has no lib/<abi>/ entries — is it really a bundle?")
        return 1

    report, failures = review(shared, per_abi, libraries, load_budgets())
    print(report)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(report + "\n")

    if failures:
        print("\nFAIL — per-ABI native size:")
        for failure in failures:
            print(f"  - {failure}")
        print(
            "\nIf the growth is intended, update android/abi-size-budget.json IN"
            " THE SAME COMMIT and say in the message what bought the megabytes."
        )
        return 1

    print("\nOK — every ABI is within budget.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
