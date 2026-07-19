// US-1606 / AGENTIC-OS Phase 2 (Module K): agent durable memory — the pure core.
//
// What an agent learned persists across runs: curated learnings assembled into
// its context each run, deduped by key, and pruned so memory stays small and
// sharp. THE CAPS ARE THE FEATURE (vault/70-agent/agentic-os-map.md §3.K — quality over quantity);
// keep them tight. The kernel does the I/O (agent_memory table, unique
// (agent_id, kind, key)); this module is the selection + write-merge + curation.

export interface MemoryRow {
  id?: string;
  kind: string;
  key: string;
  content: unknown;
  weight: number;
  updated_at: string; // ISO
}

export interface MemoryWrite {
  kind: string;
  key: string;
  content: unknown;
}

// Tight, deliberate caps.
export const MEMORY_CONTEXT_MAX_ROWS = 8; // rows injected into a run
export const MEMORY_CONTEXT_TOKEN_CAP = 800; // hard token budget for the block
export const MEMORY_ROW_CAP = 40; // hard per-agent stored-row cap
export const MEMORY_WEIGHT_BUMP = 1; // a re-written memory gains this
export const MEMORY_WEIGHT_MAX = 10; // weight ceiling (a memory can't dominate forever)
export const MEMORY_DECAY = 0.8; // per-curation multiplicative decay
export const MEMORY_WEIGHT_FLOOR = 0.3; // decayed below this ⇒ pruned

// Rough token estimate — chars/4, the usual heuristic. Pure.
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(s.length / 4);
}

// Order memory strongest-first: weight desc, then most-recently-updated. Pure.
export function orderMemory(rows: readonly MemoryRow[]): MemoryRow[] {
  return [...rows].sort((a, b) => (b.weight - a.weight) || (Date.parse(b.updated_at) - Date.parse(a.updated_at)));
}

// Select the rows to inject into a run: strongest first, stopping at the row cap
// OR the token budget (whichever binds first). Pure + deterministic.
export function selectMemoryForContext(
  rows: readonly MemoryRow[],
  opts: { maxRows?: number; tokenCap?: number } = {},
): MemoryRow[] {
  const maxRows = opts.maxRows ?? MEMORY_CONTEXT_MAX_ROWS;
  const tokenCap = opts.tokenCap ?? MEMORY_CONTEXT_TOKEN_CAP;
  const ordered = orderMemory(rows);
  const selected: MemoryRow[] = [];
  let tokens = 0;
  for (const r of ordered) {
    if (selected.length >= maxRows) break;
    const t = estimateTokens(r.content) + estimateTokens(`${r.kind}:${r.key}`);
    if (selected.length > 0 && tokens + t > tokenCap) break; // always allow at least one row
    selected.push(r);
    tokens += t;
  }
  return selected;
}

// Render the selected memory as a compact, SELF-DESCRIBING context block (so an
// agent's charter need not each repeat what memory is). Pure. Empty rows → "".
export function formatMemoryBlock(rows: readonly MemoryRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const c = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    return `- [${r.kind}] ${r.key}: ${c}`;
  });
  return [
    "MEMORY (durable learnings from your prior runs — durable facts you recorded,",
    "not this run's data). Use them to avoid re-deriving what you already know; do",
    "not treat them as current readings. To record a NEW learning, add it to a",
    '"memory" array in your output as {"kind":<short>,"key":<stable id>,"content":<value>}.',
    ...lines,
  ].join("\n");
}

// ── Write-merge (dedup by key + enforce the row cap) ─────────────────────────

export interface MemoryMergeResult {
  rows: MemoryRow[]; // the full post-merge set (<= rowCap)
  evicted: MemoryRow[]; // rows dropped to stay under the cap
  upserts: MemoryRow[]; // rows created/updated by the writes (for persistence)
}

// Apply an agent's emitted memory writes to its existing rows: dedup by
// (kind,key) — UPDATE content + refresh updated_at + bump weight, never append a
// duplicate — then enforce the hard row cap by evicting the weakest. Pure; the
// caller persists `upserts` and deletes `evicted`.
export function applyMemoryWrites(
  existing: readonly MemoryRow[],
  writes: readonly MemoryWrite[],
  opts: { rowCap?: number; nowIso: string },
): MemoryMergeResult {
  const rowCap = opts.rowCap ?? MEMORY_ROW_CAP;
  const byKey = new Map<string, MemoryRow>();
  for (const r of existing) byKey.set(`${r.kind} ${r.key}`, { ...r });
  const upserts: MemoryRow[] = [];

  for (const w of writes) {
    if (!w || typeof w.kind !== "string" || typeof w.key !== "string" || !w.kind || !w.key) continue;
    const k = `${w.kind} ${w.key}`;
    const prev = byKey.get(k);
    const merged: MemoryRow = prev
      ? { ...prev, content: w.content, weight: Math.min(MEMORY_WEIGHT_MAX, prev.weight + MEMORY_WEIGHT_BUMP), updated_at: opts.nowIso }
      : { kind: w.kind, key: w.key, content: w.content, weight: 1, updated_at: opts.nowIso };
    byKey.set(k, merged);
    upserts.push(merged);
  }

  let rows = [...byKey.values()];
  let evicted: MemoryRow[] = [];
  if (rows.length > rowCap) {
    const ordered = orderMemory(rows); // strongest first
    evicted = ordered.slice(rowCap);
    rows = ordered.slice(0, rowCap);
  }
  return { rows, evicted, upserts };
}

// ── Curation (weekly decay + prune + cap) ────────────────────────────────────

export interface MemoryCurationResult {
  keep: MemoryRow[];
  drop: MemoryRow[]; // pruned (decayed below floor, or over cap)
  decayed: number; // rows whose weight was reduced
}

// Decay every row's weight; drop rows that fall below the floor (a proxy for
// "unused for M runs" — a memory keeps its strength only if it's re-written) and
// then enforce the row cap by dropping the weakest. Pure. Pruning decisions are
// logged by the caller as ops events.
export function curateMemory(
  rows: readonly MemoryRow[],
  opts: { decay?: number; floor?: number; rowCap?: number } = {},
): MemoryCurationResult {
  const decay = opts.decay ?? MEMORY_DECAY;
  const floor = opts.floor ?? MEMORY_WEIGHT_FLOOR;
  const rowCap = opts.rowCap ?? MEMORY_ROW_CAP;

  const decayedRows = rows.map((r) => ({ ...r, weight: Number((r.weight * decay).toFixed(4)) }));
  const decayed = decayedRows.length;

  const belowFloor = decayedRows.filter((r) => r.weight < floor);
  let survivors = decayedRows.filter((r) => r.weight >= floor);

  let overCap: MemoryRow[] = [];
  if (survivors.length > rowCap) {
    const ordered = orderMemory(survivors);
    overCap = ordered.slice(rowCap);
    survivors = ordered.slice(0, rowCap);
  }

  return { keep: survivors, drop: [...belowFloor, ...overCap], decayed };
}

// Validate + coerce a raw model-emitted `memory` array into MemoryWrites. Pure.
export function parseMemoryWrites(raw: unknown): MemoryWrite[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryWrite[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.kind !== "string" || typeof o.key !== "string" || !o.kind || !o.key) continue;
    out.push({ kind: o.kind, key: o.key, content: o.content ?? null });
  }
  return out;
}
