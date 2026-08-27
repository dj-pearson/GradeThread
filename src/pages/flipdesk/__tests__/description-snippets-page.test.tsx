// US-2961 AC1: the settings page lists snippets with name, body, reorder and
// delete.
//
// renderToStaticMarkup is the repo's convention (no @testing-library), so this
// asserts first paint: the empty state, the row anatomy, and the per-row
// controls — which are the parts that rot silently when the list changes shape.
// The data hook and the confirm dialog are mocked because neither is what is
// under test: one is a thin TanStack wrapper over the same Supabase calls
// flipdesk-snippets.test.ts covers, and the other needs a provider.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ListingSnippetRow } from "@/types/database";

const state = {
  snippets: [] as ListingSnippetRow[],
  isLoading: false,
  isError: false,
  isFetching: false,
  loaded: true,
  refetch: () => {},
  create: async () => ({}) as ListingSnippetRow,
  update: async () => {},
  remove: async () => {},
  reorder: async () => {},
  isMutating: false,
};

vi.mock("@/hooks/use-listing-snippets", () => ({
  useListingSnippets: () => state,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));

const { FlipdeskDescriptionSnippetsPage } = await import(
  "@/pages/flipdesk/description-snippets"
);

const row = (over: Partial<ListingSnippetRow>): ListingSnippetRow => ({
  id: "s1",
  user_id: "u1",
  name: "Shipping promise",
  body: "Ships within one business day, tracked.",
  sort_order: 0,
  created_at: "2026-08-27T00:00:00Z",
  updated_at: "2026-08-27T00:00:00Z",
  ...over,
});

function markup(snippets: ListingSnippetRow[], over: Partial<typeof state> = {}) {
  Object.assign(state, { snippets, isLoading: false, isError: false }, over);
  return renderToStaticMarkup(
    <MemoryRouter>
      <FlipdeskDescriptionSnippetsPage />
    </MemoryRouter>,
  );
}

describe("Description snippets page (US-2961 AC1)", () => {
  it("offers a way in when there is nothing yet", () => {
    const html = markup([]);
    expect(html).toContain("No snippets yet");
    expect(html).toContain("Write your first snippet");
  });

  it("shows each snippet's name and its full body", () => {
    // The BODY, not a summary. A standing line is a paragraph a seller has to
    // proofread, and truncating it here would mean the only place to read it
    // back is the edit dialog.
    const html = markup([
      row({ id: "a", name: "Shipping promise" }),
      row({ id: "b", name: "Bundle offer", body: "Two or more? Ask me for a deal." }),
    ]);
    expect(html).toContain("Shipping promise");
    expect(html).toContain("Ships within one business day, tracked.");
    expect(html).toContain("Bundle offer");
    expect(html).toContain("Two or more? Ask me for a deal.");
  });

  it("names every per-row control after the row it acts on", () => {
    // Three snippets means three Edit buttons, and "Edit" alone says nothing
    // about which. US-2450's rule, and it applies to a settings list as much as
    // to a table of two hundred.
    const html = markup([row({ id: "a", name: "Shipping promise" })]);
    for (const label of [
      "Move Shipping promise up",
      "Move Shipping promise down",
      "Edit Shipping promise",
      "Delete Shipping promise",
    ]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
  });

  it("cannot move the first row up or the last row down", () => {
    const html = markup([
      row({ id: "a", name: "First" }),
      row({ id: "b", name: "Middle" }),
      row({ id: "c", name: "Last" }),
    ]);
    const disabledAt = (label: string) => {
      const at = html.indexOf(`aria-label="${label}"`);
      expect(at, label).toBeGreaterThan(0);
      // The button's own tag, back to its opening bracket. Matched on the
      // ATTRIBUTE, `disabled=""`, not on the substring: every shadcn button
      // carries `disabled:opacity-50` in its class list, so a bare
      // includes("disabled") is true for all of them and this case would pass
      // whatever the code did.
      const tag = html.slice(html.lastIndexOf("<button", at), at);
      return tag.includes('disabled=""');
    };
    expect(disabledAt("Move First up")).toBe(true);
    expect(disabledAt("Move Last down")).toBe(true);
    expect(disabledAt("Move Middle up")).toBe(false);
    expect(disabledAt("Move Middle down")).toBe(false);
  });

  it("surfaces a failed load with a retry instead of an empty list", () => {
    const html = markup([], { isError: true });
    // Escaped: renderToStaticMarkup writes the apostrophe as &#x27;.
    expect(html).toContain("Couldn&#x27;t load your snippets");
    expect(html).not.toContain("No snippets yet");
  });
});
