// US-2961: the seller's standing description lines.
//
// A snippet is a paragraph they write once — a shipping promise, a bundling
// offer, a returns note — and reference from any number of listings. The
// listing's block stores ONLY the id, so fixing the shipping line fixes it
// everywhere on the next render rather than one listing at a time.
//
// Owner-managed straight to Supabase under RLS, like the watchlist and the
// FlipDesk settings row: the four policies on `listing_snippets` (migration
// 00678) are `(select auth.uid()) = user_id`, so the browser client can only
// ever see and write the caller's own rows. The edge service reads the same
// table with the service-role client when it RENDERS a description, which is
// the only thing that needs to cross a tenant boundary and the reason
// apply-to-drafts is a route rather than a query from here.
//
// Design: docs/superpowers/specs/2026-08-27-modular-listing-descriptions-design.md

import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import type {
  ListingSnippetInsert,
  ListingSnippetRow,
  ListingSnippetUpdate,
} from "@/types/database";

/** One query key, so an edit anywhere refreshes the composer's row labels too. */
export const SNIPPETS_QUERY_KEY = ["flipdesk_listing_snippets"] as const;

export const SNIPPET_NAME_MAX = 80;
export const SNIPPET_BODY_MAX = 4000;

// ─── Validation ────────────────────────────────────────────────────

/**
 * Why this name cannot be saved, or null.
 *
 * Uniqueness is enforced here and not in the database on purpose: two snippets
 * called "Shipping" are a usability problem, not a data-integrity one, and a
 * unique index would turn a seller's second draft of a line into a 23505 they
 * cannot read. `selfId` exempts the row being edited from its own name.
 */
export function nameProblem(
  name: string,
  existing: readonly ListingSnippetRow[],
  selfId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give it a name.";
  if (trimmed.length > SNIPPET_NAME_MAX) {
    return `Names stop at ${SNIPPET_NAME_MAX} characters.`;
  }
  const clash = existing.some(
    (s) => s.id !== selfId && s.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? "You already have one with that name." : null;
}

/** Why this body cannot be saved, or null. */
export function bodyProblem(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return "Write what it should say.";
  if (trimmed.length > SNIPPET_BODY_MAX) {
    return `Snippets stop at ${SNIPPET_BODY_MAX.toLocaleString()} characters.`;
  }
  return null;
}

// ─── Ordering ──────────────────────────────────────────────────────

/** Where a new snippet goes: after everything that already exists. */
export function nextSortOrder(existing: readonly ListingSnippetRow[]): number {
  return existing.reduce((max, s) => Math.max(max, s.sort_order), -1) + 1;
}

/**
 * Move one row and restamp `sort_order` on every row, densely from zero.
 *
 * Restamping ALL of them rather than only the moved one is what keeps the order
 * total: rows created before this feature can share a sort_order of 0, and a
 * move that only rewrote the dragged row would leave the list resolving ties by
 * whatever order Postgres felt like returning.
 */
export function reorderSnippets(
  rows: readonly ListingSnippetRow[],
  from: number,
  to: number,
): ListingSnippetRow[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) {
    return rows.map((s, i) => ({ ...s, sort_order: i }));
  }
  const out = rows.slice();
  const taken = out.splice(from, 1);
  out.splice(to, 0, ...taken);
  return out.map((s, i) => ({ ...s, sort_order: i }));
}

/** Sort as the list and the renderer both read them. */
export function sortSnippets(rows: readonly ListingSnippetRow[]): ListingSnippetRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

/** id -> name, the shape the composer's block rows want. */
export function snippetNames(
  rows: readonly ListingSnippetRow[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of rows) out[s.id] = s.name;
  return out;
}

// ─── Reads and writes ──────────────────────────────────────────────

export async function listSnippets(userId: string): Promise<ListingSnippetRow[]> {
  const { data, error } = await supabase
    .from("listing_snippets")
    .select("*")
    .eq("user_id", userId)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return sortSnippets((data ?? []) as ListingSnippetRow[]);
}

export async function createSnippet(
  input: ListingSnippetInsert,
): Promise<ListingSnippetRow> {
  const { data, error } = await supabase
    .from("listing_snippets")
    // `as never`: the tsc -b project-reference quirk that types generated
    // Insert shapes as `never`. Same workaround as use-watchlist.ts.
    .insert({
      ...input,
      name: input.name.trim(),
      body: input.body.trim(),
    } as never)
    .select("*")
    .single();
  if (error) throw error;
  return data as ListingSnippetRow;
}

export async function updateSnippet(
  id: string,
  patch: ListingSnippetUpdate,
): Promise<void> {
  const clean: ListingSnippetUpdate = { ...patch };
  if (typeof clean.name === "string") clean.name = clean.name.trim();
  if (typeof clean.body === "string") clean.body = clean.body.trim();
  const { error } = await supabase
    .from("listing_snippets")
    .update(clean as never)
    .eq("id", id);
  if (error) throw error;
}

export async function deleteSnippet(id: string): Promise<void> {
  const { error } = await supabase.from("listing_snippets").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Persist a reorder.
 *
 * One statement per row. `upsert` would be fewer round trips and would also
 * need every column of every row to be present, which turns a reorder into a
 * rewrite of bodies the seller did not touch — and any row that arrived stale
 * would silently revert their last edit.
 */
export async function persistOrder(rows: readonly ListingSnippetRow[]): Promise<void> {
  for (const row of rows) {
    const { error } = await supabase
      .from("listing_snippets")
      .update({ sort_order: row.sort_order } as never)
      .eq("id", row.id);
    if (error) throw error;
  }
}

// ─── Apply to open drafts ──────────────────────────────────────────

export interface SnippetApplyResult {
  applied: number;
  skipped: number;
  truncated: boolean;
}

/**
 * Re-render the DRAFT listings that reference this snippet.
 *
 * Goes through the edge service because rendering is edge-only (decision 6) —
 * and because the draft-only rule has to live on the server, where the seller's
 * browser cannot widen it. A published listing is never touched.
 */
export async function applySnippetToDrafts(id: string): Promise<SnippetApplyResult> {
  const res = await edgeFetch(`/api/flipdesk/description/snippets/${id}/apply`, {
    method: "POST",
  });
  const json = (await res.json().catch(() => ({}))) as Partial<SnippetApplyResult> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(json.error || "Could not update your open drafts. Try again.");
  }
  return {
    applied: json.applied ?? 0,
    skipped: json.skipped ?? 0,
    truncated: json.truncated === true,
  };
}

/** What to tell the seller after an apply run. */
export function applySummary(result: SnippetApplyResult): string {
  if (result.applied === 0 && result.skipped === 0) {
    return "No open drafts use this one yet.";
  }
  const parts = [
    `Updated ${result.applied} draft${result.applied === 1 ? "" : "s"}.`,
  ];
  if (result.skipped > 0) {
    parts.push(
      result.skipped === 1
        ? "1 kept its own wording."
        : `${result.skipped} kept their own wording.`,
    );
  }
  if (result.truncated) {
    parts.push("There were more than we do in one go — run it again.");
  }
  return parts.join(" ");
}

export type { ListingSnippetRow };
