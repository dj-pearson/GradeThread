#!/usr/bin/env python3
"""US-1008 — fail CI if the iOS app relaxes App Transport Security (ATS) or if a
base URL is configured over plaintext http.

Two config-drift guards, same security theme:

1. ATS posture. The merged Release Info.plist (and its sources: project.yml
   `info.properties` + every committed/generated Info.plist) must NOT contain
   any ATS relaxation key. With no `NSAppTransportSecurity` dict, iOS enforces
   https + modern TLS for every connection — that is the posture we ship. A
   stray `NSAllowsArbitraryLoads` or a per-domain
   `NSExceptionAllowsInsecureHTTPLoads` would silently re-open plaintext http.

2. Base URLs. `SUPABASE_URL` / `EDGE_API_URL` in every xcconfig must be https.
   AppConfig fatal-errors on a non-https base URL at launch (so the unit tests
   catch it), but we also refuse it here so a bad xcconfig fails the lint
   immediately — config drift to an http base URL has bitten this project.

Runnable locally on Windows (`python3 ios/Scripts/check-ats.py`) like
no-ungated-print.py; also wired into .github/workflows/ios-ci.yml. In CI run it
AFTER `xcodegen generate` so the regenerated Info.plist is what gets scanned.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ATS relaxation keys. Any of these in a plist (or in project.yml's info block)
# weakens the default secure posture; none are allowed.
FORBIDDEN_ATS_KEYS = [
    "NSAllowsArbitraryLoads",
    "NSAllowsArbitraryLoadsForMedia",
    "NSAllowsArbitraryLoadsInWebContent",
    "NSAllowsLocalNetworking",
    "NSExceptionDomains",
    "NSExceptionAllowsInsecureHTTPLoads",
    "NSThirdPartyExceptionAllowsInsecureHTTPLoads",
    "NSExceptionMinimumTLSVersion",
    "NSThirdPartyExceptionMinimumTLSVersion",
]

# Base-URL build settings that must resolve to https.
HTTPS_REQUIRED_KEYS = ("SUPABASE_URL", "EDGE_API_URL")


def find_info_plists():
    """Every Info.plist under ios/ (committed + any xcodegen-regenerated one)."""
    found = []
    for dirpath, _dirs, files in os.walk(ROOT):
        # Skip build artefacts / SPM checkouts.
        if any(part in dirpath for part in (".build", "build", "DerivedData")):
            continue
        for name in files:
            if name == "Info.plist":
                found.append(os.path.join(dirpath, name))
    return found


def scan_ats(offenders):
    """Flag any ATS relaxation key in project.yml or any Info.plist."""
    targets = [os.path.join(ROOT, "project.yml")] + find_info_plists()
    for path in targets:
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for key in FORBIDDEN_ATS_KEYS:
            if key in text:
                rel = os.path.relpath(path, ROOT)
                offenders.append(
                    f"{rel}: ATS relaxation key '{key}' is forbidden — "
                    f"the app must enforce https for all connections."
                )


def normalize_xcconfig_value(raw):
    """xcconfig escapes // in URLs as /$()/ so the parser doesn't see a comment.
    Strip the $() escape and surrounding whitespace to recover the real URL."""
    return raw.replace("$()", "").strip()


def scan_base_urls(offenders):
    """Flag any SUPABASE_URL / EDGE_API_URL xcconfig value that isn't https."""
    for dirpath, _dirs, files in os.walk(ROOT):
        if any(part in dirpath for part in (".build", "build", "DerivedData")):
            continue
        for name in files:
            if not name.endswith(".xcconfig"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, start=1):
                    # Strip trailing `// comment`, but only the real comment —
                    # the $() escape protects the // inside the URL itself.
                    code = line.split("//", 1)[0] if "$()" not in line else line
                    for key in HTTPS_REQUIRED_KEYS:
                        m = re.match(rf"^\s*{key}\s*=\s*(.*)$", code)
                        if not m:
                            continue
                        value = normalize_xcconfig_value(m.group(1))
                        if not value:
                            continue  # blank/templated — nothing to validate
                        if not value.lower().startswith("https://"):
                            rel = os.path.relpath(path, ROOT)
                            offenders.append(
                                f"{rel}:{lineno}: {key} must be https — got '{value}'."
                            )


def main():
    offenders = []
    scan_ats(offenders)
    scan_base_urls(offenders)

    if offenders:
        print("iOS transport-security check FAILED (US-1008):")
        for o in offenders:
            print(f"  {o}")
        return 1
    print("OK: no ATS relaxation and all base URLs are https.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
