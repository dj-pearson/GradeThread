# Pin to Deno 2.x.
# deno.lock is lockfile "version": 5, which requires Deno 2.x — Deno 1.46.x
# cannot read a v5 lock and fails `deno cache` at build time. Stay on the debian
# (glibc) variant: more compatible than alpine for esm.sh deps.
FROM denoland/deno:debian-2.9.3

# US-513: stamp the build with the commit SHA so a specific prior image can be
# redeployed deterministically and the running version is observable. Coolify
# passes the commit via a build arg (set GIT_SHA=$SOURCE_COMMIT in the build
# args, or CF/CI equivalent). RELEASE_SHA is what lib/observability.ts reads to
# tag errors/metrics + report on /health.
ARG GIT_SHA=dev
ENV RELEASE_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/dj-pearson/GradeThread"

# Patch known base-image OS CVEs before the app layers (stable, rarely-changing
# layer). The Trivy gate (security.yml, --severity HIGH,CRITICAL --ignore-unfixed
# --exit-code 1) fails the build on a fixed-but-unpatched CVE — e.g. CVE-2026-45447
# in libssl shipped by denoland/deno:debian-2.8.0. A targeted --only-upgrade keeps
# the image small and avoids a full dist-upgrade. Re-run this when Trivy flags a
# new fixed OS CVE, or bump the base image once denoland ships a patched tag.
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
USER root
RUN apt-get update \
    && apt-get install --only-upgrade -y \
        libssl3t64 openssl-provider-legacy openssl \
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
