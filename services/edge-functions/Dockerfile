# Pin to Deno 2.x.
# deno.lock is lockfile "version": 5, which requires Deno 2.x — Deno 1.46.x
# cannot read a v5 lock and fails `deno cache` at build time. Stay on the debian
# (glibc) variant: more compatible than alpine for esm.sh deps.
FROM denoland/deno:debian-2.9.6

# US-513/US-2001: stamp the build with the commit SHA so a specific prior image
# can be redeployed deterministically and the running version is observable.
# RELEASE_SHA is what lib/observability.ts reads to tag errors and report on
# /health.
#
# ⚠ SOURCE_COMMIT MUST BE DECLARED HERE OR DOCKER THROWS IT AWAY. Coolify passes
# the commit as a build argument named SOURCE_COMMIT, but Docker only exposes a
# build arg the Dockerfile has DECLARED with ARG — an undeclared one is silently
# ignored with a warning nobody reads. This file declared only GIT_SHA, so the
# commit Coolify was already sending never reached the image, and /health/ready
# reported release "unknown" while the operator had, correctly, set nothing.
#
# GIT_SHA now DEFAULTS to SOURCE_COMMIT rather than to "dev". An ARG may use a
# previously-declared ARG as its default, so the chain is: an explicitly-set
# GIT_SHA wins; otherwise Coolify's SOURCE_COMMIT flows through on its own; and
# with neither, RELEASE_SHA is EMPTY.
#
# Empty is deliberate and is not a regression. "" is in RELEASE_PLACEHOLDERS
# (lib/release-identity.ts) exactly like "dev" was, so resolveRelease falls
# through to the next key instead of treating it as a real build — while the old
# literal `dev` default was itself the failure US-2001 recorded: an ARG default
# surviving the build and reading as an identity.
#
# ⚠ A HAND-CREATED COOLIFY VARIABLE NAMED SOURCE_COMMIT SHADOWS THE BUILT-IN ONE.
# If one exists with a blank value, this chain resolves to empty and the release
# stays unknown no matter what else is set. Delete it and let Coolify supply it.
ARG SOURCE_COMMIT=""
ARG GIT_SHA=${SOURCE_COMMIT}
ENV RELEASE_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/dj-pearson/GradeThread"

# Patch base-image OS CVEs before the app layers (stable, rarely-changing layer).
# The Trivy gate (security.yml, --severity HIGH,CRITICAL --ignore-unfixed
# --exit-code 1) fails the build on a fixed-but-unpatched CVE — first
# CVE-2026-45447 in libssl, then CVE-2026-53615 in util-linux.
#
# This used to say "a targeted --only-upgrade keeps the image small and avoids a
# full dist-upgrade. Re-run this when Trivy flags a new fixed OS CVE." That
# instruction is what left the Security lane red: it makes the gate depend on
# somebody editing a package list between the advisory landing and the next
# person looking. The apt step below now upgrades the base wholesale; the
# reasoning is there.
#
# `curl` is installed here because EVERY Coolify Scheduled Task (COOLIFY.md) is a
# `curl -fsS -X POST …` into a localhost job endpoint. The denoland/deno:debian
# base ships without curl, so without this line every cron silently no-ops (the
# command dies with "curl: not found" before the request is ever made — the app
# logs show nothing). The container healthcheck deliberately uses `deno eval`
# instead, which masked the gap. Keep curl here or the entire background-job
# fleet (drip, eBay sync, email-retry, trial-expiry, …) stops running.
#
# US-1762: `ffmpeg` decodes the walk-around clip into still frames
# (lib/video-frames.ts). It is the ONE thing on this image that cannot be done
# in TypeScript — a phone's H.264/HEVC clip needs a real decoder. Installed from
# the same freshly-updated apt index as curl, so it lands on the latest patched
# build and the Trivy gate's --ignore-unfixed stays satisfiable. If it is ever
# removed, video grading does NOT crash: ffmpegAvailable() probes once and every
# video submission falls back to needs_photos, uncharged.
# PATCH THE WHOLE BASE, not a named list. This was
# `apt-get install --only-upgrade -y libssl3t64 openssl-provider-legacy openssl`,
# added when Trivy failed on an OpenSSL advisory. It worked, and it is the wrong
# shape: the next advisory landed on util-linux (CVE-2026-53615, an integer
# overflow in libblkid) and took the Security lane red across NINE binaries from
# that one source package — bsdutils, libblkid1, liblastlog2-2 and the rest.
# Editing the list per CVE means the gate is red between the advisory and the
# person who notices.
#
# WHY `upgrade` REACHES THE FIX: the patched util-linux is 2.41.5-0+deb13u1, and
# it exists only in **trixie-security** — plain trixie still carries the
# vulnerable 2.41-5. The official Debian base has that suite in its sources, so
# `apt-get update && apt-get upgrade` picks it up. That is also why the openssl
# line above ever worked; it was never about naming the package.
#
# The cost, stated: a blanket upgrade makes the image less byte-reproducible
# between builds. That is the right trade here — the image is rebuilt on every
# deploy anyway, and the gate exists to demand current patches.
USER root
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so dep caching can be a separate layer.
COPY deno.json deno.lock* ./

# Copy source
COPY . .

# Pre-cache modules into the image so cold-start is fast.
#   --no-check    : skip type-checking during build (handled at runtime if needed)
#   --reload      : ignore any partial cache from previous layers
#   `|| true`     : if a single dep registry blips, don't fail the whole build —
#                   Deno will fetch on first request and the container still works.
RUN deno cache --no-check --reload src/main.ts || \
    echo "[build] deno cache had warnings — modules will resolve at runtime"

EXPOSE 8787

# Coolify, Docker, and Traefik all use this healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD deno eval "fetch('http://127.0.0.1:8787/health').then(r => r.ok ? Deno.exit(0) : Deno.exit(1)).catch(() => Deno.exit(1))"

# --no-check at runtime too: we type-check via tsc / deno check separately,
# not on every container start.
# US-1762 adds two NARROW permissions for video frame extraction, and nothing
# wider: --allow-run=ffmpeg (the decoder, by name, not blanket subprocess
# rights) and --allow-write=/tmp (the clip has to be a SEEKABLE file for
# ffmpeg's fast -ss seek; a piped MP4 whose moov atom trails the media, which is
# what a phone writes, cannot be seeked at all). The temp file is always
# removed, including on failure. Without these the extractor reports
# "unavailable" and video submissions fall back to needs_photos rather than
# erroring.
CMD ["deno", "run", "--no-check", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/tmp", "--allow-run=ffmpeg", "src/main.ts"]
