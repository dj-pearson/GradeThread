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
BODY="$(curl -fsSL -H 'Accept: application/json' "$URL")" || {
  echo "FAIL: could not fetch AASA (HTTP error or unreachable)"
  exit 1
}

# Must be valid JSON. Apple requires application/json with no redirect, and a
# 503 body from the function is valid JSON too, so the appID check below is what
# actually catches an unconfigured deploy.
if command -v python3 >/dev/null 2>&1; then
  echo "$BODY" | python3 -c 'import json,sys; json.load(sys.stdin)' || {
    echo "FAIL: AASA is not valid JSON (Apple requires application/json, no redirect)"
    exit 1
  }
fi

if [ -n "$APP_ID" ]; then
  echo "$BODY" | grep -q "$APP_ID" || {
    echo "FAIL: AASA does not list appID $APP_ID"
    echo "      served: $BODY"
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
    echo "      served: $BODY"
    exit 1
  fi
  echo "OK: AASA served, lists $FOUND (set APPLE_TEAM_ID to assert the team id)"
fi

echo "$BODY" | grep -q "$EXPECTED_PATH" || {
  echo "WARN: AASA does not mention $EXPECTED_PATH; Universal Link auth callback may not route"
}
