FROM denoland/deno:1.42.0

WORKDIR /app

# Copy dependency files first for caching
COPY deno.json .
RUN deno cache --import-map=deno.json src/main.ts || true

# Copy source
COPY . .

# Cache dependencies
RUN deno cache src/main.ts

EXPOSE 8787

# Coolify and other orchestrators rely on this to mark the container healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD deno eval "fetch('http://127.0.0.1:8787/health').then(r => r.ok ? Deno.exit(0) : Deno.exit(1)).catch(() => Deno.exit(1))"

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "src/main.ts"]
