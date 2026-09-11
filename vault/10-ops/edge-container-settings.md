---
title: Edge container settings - declared vs live
aliases: [edge container settings, compose is not deployed, EDGE_MEMORY_LIMIT_MB]
type: contract
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-11
tags: [ops, deploy, coolify, edge, capacity, observability]
summary: "Nine container settings live only in docker-compose.coolify.yml, which Coolify does not read - so each is measured here against production rather than assumed from the file."
---

# Edge container settings: declared vs live (US-2665)

`services/edge-functions/docker-compose.coolify.yml` **is not the deployed
configuration.** It is the only declaration of nine container settings, and a
setting added to it is not shipped. This note owns what each of those nine is
*supposed* to be, what production *actually* has, and **where it has to be set
to become true**. Add a setting here and in the Coolify UI, not to that file.

Sizing rationale lives in [[capacity]]; log and trace policy in
`services/edge-functions/OBSERVABILITY.md`; the deploy procedure in [[deploy]].

## How this was established, so it can be re-run

Three readings off public endpoints on `functions.gradethread.com`, no
credentials, all taken 2026-09-11:

1. `GET /health/metrics` returns `"memory": {"limit_mb": null, "headroom_pct":
   null, "pressure": "unknown"}`. `limit_mb` is `Number(Deno.env.get(
   "EDGE_MEMORY_LIMIT_MB"))` and the compose file sets it to `2048`. Null means
   that environment block did not boot the container.
2. The same response returns `"grading": {"buffer_pipeline_cap": 10}`. The code
   default is 6 and the compose file declares 6, so 10 was set somewhere outside
   this repo. **This is worse than absence: the file and production disagree.**
3. An OPTIONS preflight from `https://gradethread.com` comes back with
   `access-control-allow-headers: Content-Type, Authorization, X-API-Key,
   X-Internal-Job-Secret, X-Workspace-Owner, X-GT-Extension-Id`. That is the Hono
   app's list (`main.ts`). The compose file's Traefik `edge-cors` middleware
   declares a **shorter** list without `X-Workspace-Owner` or
   `X-GT-Extension-Id`, and a Traefik headers middleware answers the preflight
   itself. So that label block is not applied either.

Environment, labels and resources are three independent parts of the file, and
all three read as absent. `scripts/probe-prod-readonly.mjs` runs (1) and (2) on
every invocation, so this re-answers itself rather than being a number in a note.

## The nine settings

| # | Setting | Declared | Live? | Evidence / consequence |
|---|---|---|---|---|
| 1 | `PORT` | `8787` | **Moot** | `main.ts` defaults to `8787` when unset, so the service listens there either way. Nothing turns on it. |
| 2 | `EDGE_MEMORY_LIMIT_MB` | `2048` | **No** | `/health/metrics` `limit_mb: null`. `/health/metrics` cannot compute headroom, so the load-test gate and the scale-out rule in [[capacity]] are comparing against nothing. |
| 3 | `EDGE_TRACE_SAMPLE_RATE` | `0.1` | **Assume no** | Not readable from outside. The code default is **1.0** (`observability.ts` `traceSampleRate()`), so unset means every successful access line and every ok-outcome latency span is logged at 100%, not 10%. Ten times the intended log volume into an unbounded driver (row 6). |
| 4 | `GRADING_MAX_CONCURRENT_PIPELINES` | `6` | **No - it is 10** | `/health/metrics` `buffer_pipeline_cap: 10`. [[capacity]] chose 6 to hold peak base64 residency near 600 MB under a 2 GiB limit. Ten is roughly a gigabyte of peak residency, against a limit nothing is checking because of row 2. Rows 2 and 4 compound. |
| 5 | `SOURCE_COMMIT` / `COMMIT_SHA` passthrough | bare pass-through | **Working** | `/health` answers `release: d36d827cabb7f6c0341aa382a1fa9e78c8f997d0`, the tip of `origin/main`, and the same image reports `schema.expected: "00784"`, which is what that commit sets. Two facts baked into one image agree. Whether the value arrives as a build arg or as a hand-set `COMMIT_SHA` is not readable from outside; if it is hand-set it has to be updated on every deploy. |
| 6 | json-file log rotation (`max-size 10m` x `max-file 5`) | 50 MiB/container | **Unknown, assume no** | The only bound on on-host log disk, and the edge shares that volume with Postgres. Needs `docker inspect` (below). If absent, container logs grow until the volume fills. |
| 7 | Container `healthcheck` | 30s/5s/3 retries | **Yes, from the Dockerfile** | `services/edge-functions/Dockerfile` carries its own `HEALTHCHECK` with the same `deno eval` probe and a 20s start period. The image has a healthcheck whether or not any compose file is read. This one was listed as missing and is not. |
| 8 | `deploy.resources.limits` (2G / 1.5 CPU) | 2G | **Unknown, assume no** | Needs `docker inspect .HostConfig.Memory`. Unset means the container can take the whole host before the kernel intervenes. Must match row 2 if both are set. |
| 9 | `EDGE_ENV` | `production` | **Yes, set by hand** | `/health` reports `env: "production"`. It was typed into the Coolify UI on 2026-08-16 (US-2660) because the file that declares it is not read. The fix worked; the mechanism that was supposed to make it automatic did not. |

## Where a setting has to go to become true

- **Rows 2, 3, 4, 9** are ordinary environment variables: Coolify -> the edge
  application -> **Environment Variables**, then Redeploy. They are registered in
  [[env-reference]] as `Coolify edge` variables; that table is the contract for
  *which* variables exist, and this note is the contract for *what they must be
  set to*.
- **Row 8** is Coolify -> the edge application -> **Advanced / Resource Limits**
  (Memory, CPU). It is a container runtime limit, not an env var.
- **Row 6 belongs on the Docker daemon, not on this container.** Setting
  `log-driver` / `log-opts` in `/etc/docker/daemon.json` on the host bounds
  **every** container including Postgres, which is the volume the story was
  actually worried about. A per-service `logging:` block would bound the edge
  only and leave the larger writer unbounded.

## Two documents still state these as enforced, and are wrong

Both are outside the change that produced this note and both need a one-paragraph
correction:

- `services/edge-functions/OBSERVABILITY.md` § 1 says "**Enforced on-host bound
  (the policy):** `docker-compose.coolify.yml` pins the `json-file` driver with
  rotation ... a single container can never hold more than ~50 MiB of logs on
  disk". Nothing enforces that. Row 6 above is unmeasured and the file that
  declares it is not read.
- The same file § 2 says production "is configured to **`0.1`** in
  `docker-compose.coolify.yml`". Row 3 above: assume 1.0.
- `AGENTS.md` carries the same deploy line `CLAUDE.md` used to
  ("Deploy: `COOLIFY.md` + `docker-compose.coolify.yml`"). `CLAUDE.md` was
  corrected on 2026-09-11; `AGENTS.md` is a hand-kept copy with no parity guard
  and still says it.

## The one command that settles the rest

Two of the nine cannot be answered from this repo or from any public endpoint.
On the Coolify host:

```bash
docker inspect <edge-container> --format \
  '{{json .HostConfig.LogConfig}} {{.HostConfig.Memory}} {{index .Config.Labels "com.docker.compose.project.config_files"}}'
```

- `.HostConfig.LogConfig` settles row 6. `{"Type":"json-file","Config":{}}` means
  no rotation.
- `.HostConfig.Memory` settles row 8. `0` means no limit.
- `com.docker.compose.project.config_files` settles **which file Coolify reads**.
  A path ending `services/edge-functions/docker-compose.yml` means a Docker
  Compose build pack on that file; a path under
  `/data/coolify/applications/<uuid>/` means Coolify generated the compose itself,
  which is the Dockerfile build pack. See [[deploy]] for why both are still live
  candidates.

## Related

- [[deploy]] - the deploy procedure, and the open question of which build pack
- [[capacity]] - where the 2 GiB and the 6 pipelines come from
- [[env-reference]] - which variables exist, and on which surface
- [[rollback]] - redeploying a prior image, and the release field it relies on
- [[moc-ops]]
