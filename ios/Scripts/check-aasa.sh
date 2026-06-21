#!/usr/bin/env sh
# US-1156: verify the apple-app-site-association (AASA) file is served correctly
# so Universal Links (applinks:gradethread.com → /app/auth-callback) actually
# route into the app instead of silently falling back to the custom scheme.
#
# This is a MONITORING / pre-release check against the live domain, not a unit
# test — run it manually or from a scheduled monitor, NOT in PR CI (it depends
# on external DNS/CDN). Exit non-zero on any problem so a monitor can alert.
#
# Usage: ios/Scripts/check-aasa.sh [appID]
#   appID defaults to the shipping Team ID + bundle ID.

set -eu

APP_ID="${1:-RV6W9F4Y4P.com.gradethread.app}"   # <TeamID>.<bundleID>
URL="https://gradethread.com/.well-known/apple-app-site-association"
EXPECTED_PATH="/app/auth-callback"

echo "Checking AASA at $URL"
BODY="$(curl -fsSL -H 'Accept: application/json' "$URL")" || {
  echo "FAIL: could not fetch AASA (HTTP error or unreachable)"
  exit 1
}

# Must be valid JSON.
if command -v python3 >/dev/null 2>&1; then
  echo "$BODY" | python3 -c 'import json,sys; json.load(sys.stdin)' || {
    echo "FAIL: AASA is not valid JSON (Apple requires application/json, no redirect)"
    exit 1
  }
fi

# Must reference our appID and the auth-callback path.
echo "$BODY" | grep -q "$APP_ID" || {
  echo "FAIL: AASA does not list appID $APP_ID"
  exit 1
}
echo "$BODY" | grep -q "$EXPECTED_PATH" || {
  echo "WARN: AASA does not mention $EXPECTED_PATH — Universal Link auth callback may not route"
}

echo "OK: AASA served, lists $APP_ID"
