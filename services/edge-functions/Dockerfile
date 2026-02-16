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

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "src/main.ts"]
