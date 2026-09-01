// One-off: did migration 00711 land in production?
//
// Read-only, and uses no secret: the anon key ships in the browser bundle, so it
// is lifted from dist/ exactly as scripts/probe-prod-readonly.mjs does.
//
// WHAT THIS CAN AND CANNOT SEE, stated up front because the difference decides
// whether a green result means anything. Both new tables are deny-all RLS, so
// anon cannot read them either way. The signal is in WHICH refusal comes back:
//
//   42P01  relation does not exist   -> the migration did NOT apply
//   42501  permission denied         -> the table exists and RLS is denying us
//
// Those are different answers and PostgREST distinguishes them, so the probe is
// real. What it cannot see is the function BODY of bump_ebay_api_calls or the
// absence of policies — those need the operator SQL in PENDING_MIGRATIONS.md.
import { anonKeyFromDist } from "../scripts/probe-prod-readonly.mjs";

const API = process.env.PROBE_API_URL ?? "https://api.gradethread.com";
const anon = anonKeyFromDist();

async function probe(path) {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  });
  let body = null;
  try {
    body = await res.json();
  } catch { /* non-JSON */ }
  return { status: res.status, code: body?.code ?? null, message: body?.message ?? null };
}

const CASES = [
  // The two new tables. A control name proves the 42P01 answer is real and not
  // something PostgREST returns for everything.
  ["ebay_api_call_daily?select=day&limit=1", "new table"],
  ["ebay_rate_limit_snapshots?select=captured_at&limit=1", "new table"],
  ["ebay_account_deletion_log?select=buyer_rows_erased&limit=1", "new column"],
  ["gt_control_table_that_does_not_exist?select=x&limit=1", "CONTROL: must be 42P01"],
  // A table that predates this migration, to prove the endpoint is really prod.
  ["blog_posts?select=id&limit=1", "CONTROL: pre-existing"],
];

for (const [path, label] of CASES) {
  const r = await probe(path);
  const name = path.split("?")[0];
  console.log(
    `${name.padEnd(42)} ${String(r.status).padEnd(4)} ${(r.code ?? "-").padEnd(8)} ${label}`,
  );
  if (r.message) console.log(`${" ".repeat(44)}${r.message.slice(0, 110)}`);
}

// The RPC. anon had EXECUTE revoked by the migration, so the two answers are
// distinguishable: 42501 means the function EXISTS and the revoke took;
// PGRST202 means PostgREST cannot find that name at all.
const rpc = await fetch(`${API}/rest/v1/rpc/bump_ebay_api_calls`, {
  method: "POST",
  headers: {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ p_rows: [] }),
});
const rb = await rpc.json().catch(() => null);
console.log(
  `${"rpc/bump_ebay_api_calls".padEnd(42)} ${String(rpc.status).padEnd(4)} ${
    (rb?.code ?? "-").padEnd(8)
  } 42501 = exists, PGRST202 = missing`,
);
if (rb?.message) console.log(`${" ".repeat(44)}${String(rb.message).slice(0, 110)}`);
