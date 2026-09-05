---
title: Claude connector (remote MCP server)
type: reference
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/mcp-extension-queue-tools.ts
reviewed: 2026-09-05
tags: [mcp, connector, claude, api, oauth, integration]
summary: What the MCP specification and Anthropic's clients actually require of a GradeThread remote MCP server, as read from the primary sources on 2026-08-18.
---

# Claude connector (remote MCP server)

Backlog: `prd-connector.json` (US-9101..US-9128). This note is the answer to
US-9102 and the constraint list every story in that file is written against.

Everything below was read from the primary sources on **2026-08-18**. The MCP
specification ships dated revisions and the shape changed materially between
them, so re-read before implementing rather than trusting this note past its
`reviewed` date.

## The one decision that shapes everything: build dual-era

There are two incompatible eras of MCP, and GradeThread has to serve both.

| Era | Revisions | How a request works |
|---|---|---|
| **Legacy** | `2024-11-05` through `2025-11-25` | `initialize` handshake opens a session; server assigns `Mcp-Session-Id`; client may open a GET SSE stream for server-initiated messages |
| **Modern** | `2026-07-28` and later | No handshake and no session. Every POST carries its own protocol version, client info and capabilities in `params._meta` |

The specification calls a server that answers both **dual-era**, and says a
dual-era server picks its behaviour from how the client opens: a request
carrying modern `_meta` is served statelessly, an `initialize` request selects
legacy semantics. Both may share one endpoint.

**Anthropic's own MCP connector is legacy today.** The Messages API connector
(beta header `mcp-client-2025-11-20`) documents Streamable HTTP *and* SSE
transports and links the **2025-11-25** authorization spec. A GradeThread server
that implements only `2026-07-28` would be correct, current, and unable to talk
to the product we are building it for.

So: implement legacy first (that is what connects), implement modern alongside
(that is what stops this being a rewrite in six months), advertise both.

## Modern transport (2026-07-28) in detail

One endpoint. `POST` only.

- `GET` or `DELETE` on the MCP endpoint: respond `405 Method Not Allowed`.
- An `Mcp-Session-Id` header: ignore it, do not mint or echo session ids.
- A `Last-Event-ID` header: ignore it, streams are not resumable.

Every POST body is **one** JSON-RPC request or notification. There is no
batching. A notification the server accepts returns `202 Accepted` with no body.

Required request headers on every POST:

| Header | Mirrors | Required for |
|---|---|---|
| `MCP-Protocol-Version` | `params._meta["io.modelcontextprotocol/protocolVersion"]` | every request |
| `Mcp-Method` | `method` | every request |
| `Mcp-Name` | `params.name` or `params.uri` | `tools/call`, `resources/read`, `prompts/get` |

The headers exist so a load balancer can route without parsing the body, which
means the two can disagree, which is a security problem. The server **MUST**
validate header against body and reject a mismatch with `400` and JSON-RPC error
`-32020` (`HeaderMismatch`). Values that are not header-safe ASCII arrive
Base64-wrapped as `=?base64?VALUE?=` and must be decoded before comparison.

Other required behaviours:

- Validate the `Origin` header when present; `403` if invalid. This is the DNS
  rebinding defence and it is a MUST.
- Unsupported protocol version: `400` with `-32022`
  `UnsupportedProtocolVersionError`, carrying `data.supported` (the list of
  versions we speak) and `data.requested`.
- Unknown method: `404` with `-32601`. The JSON-RPC body is what distinguishes
  this from a legacy server's 404, so it is not optional.
- `server/discover` is a **MUST** implement.
- SSE responses are scoped to one request, carry `notifications/progress` or
  `notifications/message` before the final response, and should set
  `X-Accel-Buffering: no` so a reverse proxy does not buffer them.
- **Closing the SSE response stream is the cancellation signal.** There is no
  `notifications/cancelled` on HTTP. The server must stop work and send nothing
  further for that request.
- Long-lived notification streams come from a `subscriptions/listen` request,
  not from a GET.

### MRTR replaces server-initiated requests

Servers no longer send JSON-RPC requests. When the server needs input from the
user (elicitation) or the model (sampling), it returns an `InputRequiredResult`
containing `inputRequests`, and the client **retries the original request** with
matching `inputResponses`. This is SEP-2322, "Multi Round-Trip Requests".

This matters for GradeThread more than it looks. The confirm-before-publish
design in US-9116 was written as a two-call preview/confirm token exchange
because that works on every era. On modern clients, elicitation via MRTR can put
a real human prompt in front of a publish. Do both: MRTR for the human, the
token for the payload binding. Elicitation without a token still lets the
payload change between the question and the action.

## Authorization

The MCP server is an OAuth 2.1 **resource server**. Requirements, with MUST and
SHOULD as the spec states them:

- MCP servers **MUST** implement RFC 9728 Protected Resource Metadata.
- The authorization server **MUST** provide RFC 8414 metadata or OpenID Connect
  Discovery (at least one).
- Clients **MUST** send RFC 8707 `resource` on both the authorization and token
  requests, and the server **MUST** validate that a token was issued for it as
  the audience. Accepting a token minted for something else is the confused
  deputy hole this closes.
- PKCE with `S256`. `plain` is not acceptable, and Anthropic's review checks for
  S256 support specifically.
- The token endpoint must accept `application/x-www-form-urlencoded`.
- `401` carries `WWW-Authenticate: Bearer resource_metadata="...", scope="..."`.
  The `scope` parameter tells the client what to ask for, and the spec says to
  emit every scope the operation needs in one challenge rather than trickling
  them out.
- A token that is valid but under-scoped gets `403` with
  `error="insufficient_scope"` plus the required `scope`, not `401`.
- RFC 9207: the authorization server **SHOULD** return `iss` on authorization
  responses, and advertise `authorization_response_iss_parameter_supported`.
- Do not put `offline_access` in `scopes_supported` or in a `WWW-Authenticate`
  challenge. Refresh tokens are not a resource requirement.

### Dynamic Client Registration is deprecated

This is the correction that most changes the plan. RFC 7591 Dynamic Client
Registration is now **deprecated** in the MCP authorization spec, retained only
for authorization servers that do not support the replacement.

The replacement is **OAuth Client ID Metadata Documents**
(`draft-ietf-oauth-client-id-metadata-document-00`): the client's `client_id` is
an HTTPS URL, and the authorization server fetches the client metadata from that
URL and validates the `redirect_uris` it declares. Servers and clients
**SHOULD** support it.

Practical reading: support Client ID Metadata Documents as the primary path,
keep a DCR endpoint for clients that still need it, and accept pre-registered
clients. Do not build DCR as the only mechanism.

### Redirect URIs that must actually work

- Hosted Claude surfaces: `https://claude.ai/api/mcp/auth_callback`.
- Claude Code: loopback on `localhost` and `127.0.0.1` with a **varying port**.
  Exact-string redirect matching will reject it. Port-agnostic matching for
  loopback is required, and that exemption applies to loopback only.

### Authless is allowed

claude.ai supports authless remote MCP servers, and OAuth Client ID / Client
Secret are optional fields in the "Add custom connector" dialog. GradeThread
should still require auth on everything except, possibly, a public read surface,
but the platform does not force OAuth on us for a first shippable version. An
API key in `Authorization: Bearer` is enough for Claude Code and for the
Messages API connector's `authorization_token` field.

## What the surfaces require

| Surface | Transport | Auth | Notes |
|---|---|---|---|
| Claude Code | HTTP | Static header, so an API key works | `claude mcp add --transport http` |
| Messages API connector | Streamable HTTP or SSE | `authorization_token` bearer, caller obtains it | Beta `mcp-client-2025-11-20`; **tools only**, no resources or prompts; not ZDR eligible |
| claude.ai custom connector | Remote URL | OAuth optional, authless allowed | Free (one connector), Pro, Max, Team, Enterprise |
| Connector directory | **Streamable HTTP required** | OAuth per above | Team or Enterprise org, Owner role, submitted through the portal |

The Messages API connector's "tools only" limitation is the reason
`prd-connector.json` invests in tools and not in MCP resources or prompts.

## Directory submission

Not needed to ship. Needed to be findable. Requirements as published:

- Production HTTPS URL on Streamable HTTP.
- A fully populated **test account with sample data**, and not production data.
- Every tool carries a human-readable `title`.
- Every tool carries `readOnlyHint: true` **or** `destructiveHint: true`.
- Tool names at most 64 characters.
- Descriptions that match real behaviour and say when Claude should call the
  tool.
- Verified with MCP Inspector and as a live custom connector before submitting.

Documented rejection causes worth designing against now: mixing safe reads and
unsafe writes in one tool, unmarked destructive operations, missing PKCE S256,
wrong callback URLs, weak `Origin` validation, prompt injection reachable
through tool descriptions, and a reviewer account that is empty or full of real
customer data.

One policy line to watch: **transferring financial assets** is listed as a
policy violation. GradeThread's grading tool returning a Stripe checkout URL
rather than charging anything is already the right shape. Keep it that way, and
do not add a tool that moves money.

## The hostname

`https://functions.gradethread.com/mcp`.

The edge service (Deno + Hono on Coolify) is the only host that serves Hono
routes. `api.gradethread.com` is Kong and holds Supabase routes only, so an MCP
URL published there returns 404 with no obvious cause. See the DNS section of
the root `CLAUDE.md`.

## The two tools that queue work rather than doing it (US-3065)

`gradethread_extension_queue` (read) and `gradethread_queue_extension_work`
(write) let the connector answer "list these twelve on Poshmark and Mercari" by
creating rows the seller's OWN browser drains. Nothing here reaches a
marketplace, which is why the write tool's `openWorldHint` is **false** while
`gradethread_publish_listing`'s is true: the ADR in
[[adr-no-server-side-marketplace-automation]] holds, and the connector queues
rather than acts.

**The prompt says QUEUED, never live**, and that is the whole safety property. A
model reporting "done, it's listed" about a queued job is the failure this
feature is arranged around, because the seller's desktop may be shut.
`QUEUED_NOTICE` is emitted verbatim in the preview, the result and the MRTR
question, and a test fails if the module writes its own wording or if the prompt
uses the words live or listed.

> [!warning] One call is one connector action, and that is deliberate
> The monthly allowance counts ROWS IN `mcp_tool_calls`, one per tool CALL.
> There is no weight column, so a per-row charge would need the check and the
> count to agree and only the check can change without a migration — half a
> weighting would refuse legitimate calls while still under-counting the month.
>
> The precedent is also already looser: `gradethread_end_listings` takes up to
> **100 live listings off their marketplaces** for one allowance action. This
> tool's worst case is smaller, so charging per row here alone would make
> QUEUEING cost more than ENDING a hundred listings. A test pins that comparison
> and fails if the ceiling ever inverts it.

## Sources

- [MCP specification, current revision](https://modelcontextprotocol.io/specification/latest) (`2026-07-28`)
- [Streamable HTTP binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Anthropic MCP connector (Messages API)](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
- [Adding custom connectors in Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## Related

- [[marketplace-connector-contract]] for how GradeThread models an outbound
  integration; this is the first inbound one.
- [[env-reference]] for where connector secrets will be named once they exist.
