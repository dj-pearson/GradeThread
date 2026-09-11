// FIXTURE, not a script. Nothing here runs and nothing here is imported.
//
// It exists because a rule that cannot fire reads exactly like a clean
// codebase. scripts/check-operator-read-checks.mjs scans this directory before
// it scans the real one and fails if any rule stops reporting its own textbook
// instance. Do NOT "fix" the bad cases below - they are the point.
//
// Every line the guard is expected to report carries a trailing
// `MUST_FIRE <rule-id>` marker, and the guard checks the marker AND the count,
// so a rule that becomes too broad fails here too.

const db = {
  from() {
    return this;
  },
  select() {
    return this;
  },
  eq() {
    return this;
  },
  rpc() {
    return this;
  },
};

/** BAD: `data` with no `error`. A failed read arrives as an empty list. */
export async function readRowsDroppingError() {
  const { data } = await db.from("inventory_items").select("id"); // MUST_FIRE supabase-destructure-drops-error
  return data ?? [];
}

/** BAD: `count` with no `error`. A failed count prints as 0. */
export async function readCountDroppingError() {
  const { count: total } = await db // MUST_FIRE supabase-destructure-drops-error
    .from("account_deletion_log")
    .select("id", { count: "exact", head: true });
  return total ?? 0;
}

/** GOOD: the error is destructured and acted on. */
export async function readRowsCheckingError() {
  const { data, error } = await db.from("inventory_items").select("id"); // MUST_NOT_FIRE
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** GOOD: an rpc, error checked. */
export async function callRpcCheckingError() {
  const { data, error } = await db.rpc("record_style_code_name", {}); // MUST_NOT_FIRE
  if (error) throw new Error(error.message);
  return data;
}

/** GOOD: not a supabase call at all - no .from/.rpc/.storage/.auth in the statement. */
export async function readSomethingElse(source) {
  const { data } = await source.load(); // MUST_NOT_FIRE
  return data;
}
