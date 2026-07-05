// US-1595 / AGENTIC-OS Phase 1 (Module S): the Support Triage agent's pure
// domain logic. The OPERATOR-side layer over the existing support inbox — it
// classifies + prioritizes new tickets, drafts approval-gated replies, and
// detects issue CLUSTERS that should page Sentinel. It reuses the KB tooling
// from support-tools.ts; nothing here sends a reply or mutates a ticket on its
// own (writes go through approved proposals).
//
// PURE + fixture-tested. The tool feeds live rows (already redacted upstream via
// log-redact); classification itself is the charter LLM's job — this file shapes
// the memo, validates the LLM's classification output, and does the deterministic
// cluster detection.

import { redact } from "./log-redact.ts";

export const TRIAGE_CATEGORIES = [
  "billing",
  "grading",
  "technical",
  "account",
  "shipping",
  "other",
] as const;
export type TriageCategory = typeof TRIAGE_CATEGORIES[number];

export const TRIAGE_SEVERITIES = ["low", "normal", "high", "urgent"] as const;
export type TriageSeverity = typeof TRIAGE_SEVERITIES[number];

// Cluster tuning: N similar tickets inside the window escalate as one finding.
export const CLUSTER_MIN_SIZE = 3;
export const CLUSTER_WINDOW_MS = 24 * 3600_000;
export const CLUSTER_SIMILARITY = 0.5; // Jaccard on significant tokens
const EXCERPT_MAX = 280;

export interface TriageTicket {
  id: string;
  subject: string;
  excerpt: string; // first user message body (raw; redacted+trimmed by prepareExcerpt)
  created_ms: number;
  priority: string; // the ticket's CURRENT stored priority
  status: string;
}

export interface KbEntry {
  slug: string;
  title: string;
}

// ── PII minimization (AC5) ───────────────────────────────────────────────────
// Redact secrets/emails then hard-cap length. Applied before a ticket excerpt is
// ever put in front of the model or persisted in a finding.
export function prepareExcerpt(raw: string): string {
  const scrubbed = redact(raw ?? "").replace(/\s+/g, " ").trim();
  return scrubbed.length > EXCERPT_MAX ? scrubbed.slice(0, EXCERPT_MAX).trimEnd() + "…" : scrubbed;
}

// ── Classification validation (AC2/AC3 write-tool guard) ─────────────────────
export function isValidCategory(v: unknown): v is TriageCategory {
  return typeof v === "string" && (TRIAGE_CATEGORIES as readonly string[]).includes(v);
}
export function isValidSeverity(v: unknown): v is TriageSeverity {
  return typeof v === "string" && (TRIAGE_SEVERITIES as readonly string[]).includes(v);
}

export interface TicketClassification {
  ticket_id: string;
  category: TriageCategory;
  severity: TriageSeverity;
  kb_slug: string | null; // a suggested article, or null when none fits
}

// Validate one raw classification from the model. Returns null (skip) rather than
// throwing, so one bad row never drops the whole batch. kb_slug is accepted only
// when it names a real published article (validated against `knownSlugs`).
export function normalizeClassification(
  raw: unknown,
  knownSlugs: ReadonlySet<string>,
): TicketClassification | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ticketId = typeof r.ticket_id === "string" ? r.ticket_id : "";
  if (!ticketId) return null;
  if (!isValidCategory(r.category) || !isValidSeverity(r.severity)) return null;
  const slug = typeof r.kb_slug === "string" && knownSlugs.has(r.kb_slug) ? r.kb_slug : null;
  return { ticket_id: ticketId, category: r.category, severity: r.severity, kb_slug: slug };
}

// ── Cluster detection ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "have", "your", "you",
  "not", "was", "are", "but", "can", "cant", "cannot", "when", "what", "why",
  "how", "app", "please", "help", "issue", "problem", "support", "ticket",
]);

// Significant tokens: lowercased alphanumeric runs ≥4 chars, minus stopwords.
export function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])) {
    if (tok.length >= 4 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface TicketCluster {
  ticket_ids: string[];
  size: number;
  terms: string[]; // the shared tokens that bound the cluster (for the finding)
  first_ms: number;
  last_ms: number;
}

// Union-find over the "similar AND within window" relation → order-independent,
// deterministic clusters. Two tickets link when their significant-token Jaccard
// ≥ threshold and they were created within `windowMs` of each other.
export function detectClusters(
  tickets: readonly TriageTicket[],
  opts: { minSize?: number; windowMs?: number; similarity?: number } = {},
): TicketCluster[] {
  const minSize = opts.minSize ?? CLUSTER_MIN_SIZE;
  const windowMs = opts.windowMs ?? CLUSTER_WINDOW_MS;
  const sim = opts.similarity ?? CLUSTER_SIMILARITY;

  const toks = tickets.map((t) => significantTokens(`${t.subject} ${t.excerpt}`));
  const parent = tickets.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const a = find(i), b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };

  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      if (Math.abs(tickets[i].created_ms - tickets[j].created_ms) > windowMs) continue;
      if (jaccard(toks[i], toks[j]) >= sim) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < tickets.length; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(i);
    else groups.set(root, [i]);
  }

  const clusters: TicketCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < minSize) continue;
    // Shared terms = tokens present in EVERY member (the common thread).
    let shared: Set<string> | null = null;
    for (const m of members) {
      if (shared === null) shared = new Set(toks[m]);
      else for (const t of [...shared]) if (!toks[m].has(t)) shared.delete(t);
    }
    const times = members.map((m) => tickets[m].created_ms);
    clusters.push({
      ticket_ids: members.map((m) => tickets[m].id),
      size: members.length,
      terms: [...(shared ?? new Set())].sort(),
      first_ms: Math.min(...times),
      last_ms: Math.max(...times),
    });
  }
  // Largest cluster first (most urgent signal).
  clusters.sort((a, b) => b.size - a.size);
  return clusters;
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface TriageMemo {
  summary: string;
  untriaged: Array<{ id: string; subject: string; excerpt: string; priority: string; age_hours: number }>;
  clusters: TicketCluster[];
  kb_catalog: KbEntry[];
  all_clear: boolean; // nothing to triage AND no clusters
}

export function assembleTriageMemo(
  tickets: readonly TriageTicket[],
  kb: readonly KbEntry[],
  nowMs: number,
): TriageMemo {
  const clusters = detectClusters(tickets);
  const untriaged = tickets.map((t) => ({
    id: t.id,
    subject: t.subject,
    excerpt: t.excerpt,
    priority: t.priority,
    age_hours: Math.max(0, Math.round((nowMs - t.created_ms) / 3600_000)),
  }));
  const allClear = untriaged.length === 0 && clusters.length === 0;
  const parts: string[] = [`${untriaged.length} untriaged ticket(s)`];
  if (clusters.length) parts.push(`${clusters.length} cluster(s) (largest ${clusters[0].size})`);
  else if (untriaged.length) parts.push("no clusters");
  else parts.push("inbox clear");
  return {
    summary: parts.join("; ") + ".",
    untriaged,
    clusters,
    kb_catalog: [...kb],
    all_clear: allClear,
  };
}
