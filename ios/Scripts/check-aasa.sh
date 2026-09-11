#!/usr/bin/env sh
# US-1156: verify the apple-app-site-association (AASA) file is served correctly
# so Universal Links (applinks:gradethread.com -> /app/auth-callback) actually
# route into the app instead of silently falling back to the custom scheme.
#
# This is a MONITORING check against the live domain, not a unit test. It has no
# place in `npm run verify`, which must stay offline. The Uptime workflow runs it
# on the same schedule as the other external probes (US-3108 AC4).
#
# Usage: ios/Scripts/check-aasa.sh [appID]
#   With an explicit appID ("<TeamID>.<BundleID>") the file must list exactly
#   that. With none, APPLE_TEAM_ID is used when set; with neither, the check
#   validates the SHAPE and the bundle id and prints the team id it found.
#
# US-3108, 2026-09-04: this script used to default APP_ID to
# "RV6W9F4Y4P.com.gradethread.app" and had reported
#   FAIL: AASA does not list appID RV6W9F4Y4P.com.gradethread.app
# against a production file that is, in fact, correct. Production serves
# 4G65K64G73.com.gradethread.app, which is the team id in
# scripts/generate-apple-client-secret.mjs and the value of APPLE_TEAM_ID on the
# Pages project. RV6W9F4Y4P appeared in this file and nowhere else in the repo.
#
# The lesson is the reason for the rewrite: NEITHER the app nor the AASA
# hard-codes a team id. ios/project.yml takes DEVELOPMENT_TEAM from
# $APPLE_TEAM_ID and functions/.well-known/apple-app-site-association.ts takes it
# from the Pages env var of the same name, so the two cannot disagree. A third
# copy pasted into the checker could only ever go stale, and when it did, the
# guard blamed production for its own drift. Derive it or do not assert it.

set -eu

URL="${AASA_URL:-https://gradethread.com/.well-known/apple-app-site-association}"
BUNDLE_ID="${IOS_BUNDLE_ID:-com.gradethread.app}"
EXPECTED_PATH="/app/auth-callback"
# Explicit argument wins; otherwise the build/deploy variable; otherwise unset.
APP_ID="${1:-}"
if [ -z "$APP_ID" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  APP_ID="${APPLE_TEAM_ID}.${BUNDLE_ID}"
fi

echo "Checking AASA at $URL"

# NO -L AND NO -f, both deliberately. Apple fetches this file with no redirect
# following and no content sniffing, so a 301, or a 200 carrying text/html, is
# "app installed but links do not open it" with nothing logged anywhere.
#
# US-3108, 2026-09-10: the fetch was `curl -fsSL`, and -L hid exactly that
# failure. Pointed at http://gradethread.com/.well-known/... - which 301s to
# https - the check printed OK and exited 0, because curl followed the hop Apple
# would have stopped at. The two conditions the story's AC names in so many
# words ("served as application/json with no redirect") were the two this probe
# could not see. -f is dropped as well so the real status can be reported
# instead of collapsing every non-2xx into one exit code.
BODY_FILE="${TMPDIR:-/tmp}/aasa-body.$$"
trap 'rm -f "$BODY_FILE"' EXIT

# '|' separates the two %{} fields; neither a status code nor a Content-Type
# can contain one, and an absent Content-Type leaves the field empty (which
# fails the check below, as it should).
META="$(curl -sS -o "$BODY_FILE" -w '%{http_code}|%{content_type}' \
  -H 'Accept: application/json' "$URL")" || {
  echo "FAIL: could not fetch AASA (unreachable)"
  exit 1
}
STATUS="${META%%|*}"
CONTENT_TYPE="${META#*|}"
BODY="$(cat "$BODY_FILE")"
# A wrong body is usually a whole SPA shell. The real AASA is ~264 bytes, so
# 400 characters shows all of a correct file and enough of a wrong one to
# recognise it, without pushing 70KB of HTML into a CI log.
BODY_PREVIEW="$(printf '%s' "$BODY" | head -c 400)"
# `[ ... ] && x=y` would be the last command of the script's current statement,
# and a false test returns 1, which `set -e` turns into an exit. Use if/fi.
if [ "${#BODY}" -gt 400 ]; then
  BODY_PREVIEW="$BODY_PREVIEW ... (truncated, ${#BODY} bytes)"
fi

case "$STATUS" in
  200) ;;
  3*)
    echo "FAIL: AASA returned HTTP $STATUS (a redirect to ${CONTENT_TYPE:-?})"
    echo "      Apple does not follow redirects for this file. It must be served"
    echo "      200 at the exact path $URL."
    exit 1
    ;;
  *)
    echo "FAIL: AASA returned HTTP $STATUS (expected 200)"
    echo "      served: $BODY_PREVIEW"
    exit 1
    ;;
esac

# Apple requires application/json. The realistic way this breaks is the Pages
# Function going missing and an SPA/404 catch-all answering 200 with text/html:
# every browser and every uptime probe reads that as a working endpoint.
case "$(printf '%s' "$CONTENT_TYPE" | tr '[:upper:]' '[:lower:]')" in
  application/json*) ;;
  *)
    echo "FAIL: AASA Content-Type is '${CONTENT_TYPE:-(none)}'; Apple requires application/json"
    echo "      served: $BODY_PREVIEW"
    exit 1
    ;;
esac

# Must also parse. A 503 body from the function is valid JSON too, so the appID
# check below is what catches an unconfigured deploy; this only catches truncated
# or non-JSON bodies that still claimed the right Content-Type.
#
# python3 is the name on the CI runner; the Windows dev box installs Python as
# `python`. Try both, and SAY SO when neither is present rather than skipping in
# silence - a check that quietly does not run reads exactly like one that passed.
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done
if [ -n "$PY" ]; then
  printf '%s' "$BODY" | "$PY" -c 'import json,sys; json.load(sys.stdin)' || {
    echo "FAIL: AASA is not valid JSON despite an application/json Content-Type"
    echo "      served: $BODY_PREVIEW"
    exit 1
  }
else
  echo "NOTE: no python on PATH, skipped the JSON parse; the appID check still runs"
fi

if [ -n "$APP_ID" ]; then
  echo "$BODY" | grep -q "$APP_ID" || {
    echo "FAIL: AASA does not list appID $APP_ID"
    echo "      served: $BODY_PREVIEW"
    exit 1
  }
  echo "OK: AASA served, lists $APP_ID"
else
  # No team id to compare against. Assert the shape instead: a well-formed
  # "<10 alphanumerics>.<bundle id>" entry. This is what catches the failure
  # that actually happened in production before US-2620 (a blank IOS_BUNDLE_ID
  # producing "<TEAMID>." and being served with HTTP 200) and it catches the
  # 503 "Universal Links not configured" body, which lists no appID at all.
  FOUND="$(printf '%s' "$BODY" |
    grep -oE '"[A-Z0-9]{10}\.'"$(printf '%s' "$BUNDLE_ID" | sed 's/\./\\./g')"'"' |
    head -n 1 | tr -d '"')" || true
  if [ -z "$FOUND" ]; then
    echo "FAIL: AASA lists no well-formed appID for bundle $BUNDLE_ID"
    echo "      served: $BODY_PREVIEW"
    exit 1
  fi
  echo "OK: AASA served, lists $FOUND (set APPLE_TEAM_ID to assert the team id)"
fi

echo "$BODY" | grep -q "$EXPECTED_PATH" || {
  echo "WARN: AASA does not mention $EXPECTED_PATH; Universal Link auth callback may not route"
}
