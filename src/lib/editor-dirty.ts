// US-2536: which fields an editor is holding that the server has not got.
//
// The blog and social editors autosave the BODY on a debounce and leave every
// other field to an explicit Save. That split is deliberate — a title change
// per keystroke is a write storm — but it means the title, slug, SEO fields and
// hashtags live only in React state, and a sidebar click threw them away with
// no warning at all.
//
// A guard that says "unsaved changes" is easy to click through. One that says
// "Title, SEO description" is not, which is why this returns the labels.

export type EditorFields = Record<string, string | null | undefined>;

/**
 * Labels of the fields whose current value differs from the last saved one.
 * Compared as trimmed strings, so whitespace the user did not mean to add does
 * not raise a dialog about work that does not exist.
 */
export function dirtyFieldLabels(
  current: EditorFields,
  saved: EditorFields,
  labels: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(labels)) {
    const a = (current[key] ?? "").toString().trim();
    const b = (saved[key] ?? "").toString().trim();
    if (a !== b) out.push(labels[key]!);
  }
  return out;
}

/** A sentence naming what is at stake, or null when nothing is. */
export function unsavedSummary(labels: string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
