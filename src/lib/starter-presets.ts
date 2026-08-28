// US-2966: the shared half of the two starter libraries.
//
// Description snippets and listing templates are different tables with
// different editors, and a seller meets both of them as the same blank page.
// The sample picker is one dialog for both, so this file holds the shape it
// renders and the one rule it needs that neither table enforces: what to call
// a sample whose name the seller is already using.
//
// The samples themselves live next door — `starter-snippets.ts` (US-2966) and
// `starter-templates.ts` (US-2968) — because the copy is the thing that will
// change, and it should change without touching the picker.

/**
 * One ready-made preset, in the shape the picker renders.
 *
 * `id` is ours, not a row id: it identifies the sample in code and in tests,
 * and is thrown away the moment the seller adds it. What they get is their own
 * row, editable and deletable like anything they wrote themselves.
 */
export interface StarterPreset {
  id: string;
  name: string;
  /** The full text shown in the picker and saved as the row's body. */
  body: string;
  /** An extra line the picker shows under the body (templates use it for the condition). */
  note?: string;
}

/**
 * A name the seller is not already using.
 *
 * Both tables reject a duplicate name — `listing_snippets` in
 * `nameProblem()`, `listing_templates` with a UNIQUE (user_id, name)
 * constraint — so adding a sample called "Returns" to an account that already
 * has one has to become something else or fail. Failing is the wrong answer
 * here: the seller ticked a box, and a 23505 they cannot read is not a reply
 * to that.
 *
 * Comparison is case-insensitive and trimmed, matching `nameProblem()`. The
 * suffix grows " (copy)", " (copy 2)", " (copy 3)" rather than counting from
 * one, because the first copy of a thing is not usually called "copy 1".
 *
 * `max` truncates the BASE, never the suffix: a name that lost its "(copy)" to
 * a length cap would collide with the row it was renamed to avoid.
 */
export function uniqueName(
  base: string,
  taken: readonly string[],
  max: number,
): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  const fit = (name: string, suffix: string): string => {
    const room = max - suffix.length;
    const head = name.length > room ? name.slice(0, Math.max(0, room)).trimEnd() : name;
    return `${head}${suffix}`;
  };

  const first = fit(base.trim(), "");
  if (!used.has(first.toLowerCase())) return first;

  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (copy)" : ` (copy ${n})`;
    const candidate = fit(base.trim(), suffix);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Rename a whole batch at once.
 *
 * The picker adds several samples in one go, so each name has to dodge the
 * account's existing rows AND the ones earlier in this same batch — otherwise
 * ticking two samples that both collide produces two rows with the same new
 * name, and the second insert is the error the rename existed to prevent.
 */
export function uniqueNames(
  bases: readonly string[],
  taken: readonly string[],
  max: number,
): string[] {
  const running = taken.slice();
  return bases.map((base) => {
    const name = uniqueName(base, running, max);
    running.push(name);
    return name;
  });
}
