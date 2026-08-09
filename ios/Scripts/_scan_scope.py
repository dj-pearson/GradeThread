"""The one list of Swift source roots the guard scripts scan (US-2342).

WHY THIS FILE EXISTS. Four scripts each carried their own copy of the same four
directory names — no-force-unwrap.py, no-ungated-print.py,
no-default-shared-session.py and no-raw-jpeg-encode.py — and every one of them
omitted ``Packages``. So the force-unwrap guard, the ungated-print guard (whose
Android half mirrors it), the URLSession.shared guard and the raw-JPEG guard
ALL skipped ios/Packages/GradeThreadCore, which is where MoneyMath.swift and
SalePnL.swift live. The money math was the least-guarded code in the app.

That is not four bugs, it is one list written four times. A shared constant is
the fix, and it is the fix specifically because the next guard someone adds
will copy a neighbour: copying an import cannot go stale the way copying a
literal did.

NOT EVERY SCRIPT SHOULD IMPORT THIS, and the exceptions are deliberate:

* ``no-bare-strings.py`` has its own ``SCOPE_DIRS`` naming individual feature
  folders. That is a LOCALIZATION MIGRATION FRONT, not a guard scope — it grows
  as strings are moved into the catalog, and widening it to the whole tree would
  fail the build on every screen nobody has migrated yet.
* ``check-ats.py`` already walks the repository root, so it never had the gap.
"""

# Every Swift source root a guard should see. `Packages` is the SPM tree; each
# package's own Tests/ directory rides along, which is correct — a force-unwrap
# in a test still crashes CI, and the guards that care about test files already
# filter them by path.
TARGET_DIRS = [
    "GradeThread",
    "ShareExtension",
    "GradeThreadWidget",
    "Shared",
    "Packages",
]
