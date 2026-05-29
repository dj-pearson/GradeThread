# Pin to Deno 2.x.
# deno.lock is lockfile "version": 5, which requires Deno 2.x — Deno 1.46.x
# cannot read a v5 lock and fails `deno cache` at build time. Stay on the debian
# (glibc) variant: more compatible than alpine for esm.sh deps.
FROM denoland/deno:debian-2.8.0

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
CMD ["deno", "run", "--no-check", "--allow-net", "--allow-env", "--allow-read", "src/main.ts"]
