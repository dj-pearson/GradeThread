/**
 * US-3013: `useQuery` with the network taken out, for the UI-layout harness.
 *
 * WHY A STUB RATHER THAN A SEEDED CACHE. `renderToString` does not await, so a
 * real `useQuery` renders its loading branch and nothing else - which is a
 * skeleton, and a skeleton is not the layout anyone needs checked. Seeding the
 * cache by key does not work either: half the keys on the Money views contain
 * `user?.id` and a `new Date()`, so the key a page asks for is not a key a
 * script can write ahead of time.
 *
 * So the key is not used for lookup. [FIXTURES] is keyed on the FIRST segment,
 * which is the stable, hand-written part of every key in this codebase, and a
 * screen with no fixture renders its empty state - which is a real layout too.
 *
 * ⚠ THIS IS A LAYOUT HARNESS, NOT A DATA TEST. Nothing here asserts that a page
 * asks for the right thing or draws the right number. It exists so the
 * browser-scoped craft-floor rules have a laid-out DOM to look at, and the only
 * thing it must get right is the SHAPE of the markup.
 *
 * Aliased over `@tanstack/react-query` for the SSR build only
 * (scripts/check-ui-authed.mjs). Nothing in the app imports it.
 */

export * from "@tanstack/react-query";

import { FIXTURES } from "./authed-fixtures";

type AnyKey = readonly unknown[];

/** The stable, hand-written head of a query key. */
function head(key: AnyKey): string {
  return typeof key[0] === "string" ? key[0] : "";
}

/**
 * The whole answer, as a plain function.
 *
 * Separate from [useQuery] so [useQueries] can call it inside a `.map` without
 * calling a hook in a callback - which is a real rule, not a lint quibble, and
 * these stubs hold no state to make it safe.
 */
function answer(key: AnyKey) {
  const data = FIXTURES[head(key)];
  return {
    data,
    error: null,
    isLoading: false,
    isPending: false,
    isFetching: false,
    isError: false,
    isSuccess: true,
    isRefetching: false,
    isPlaceholderData: false,
    status: "success" as const,
    fetchStatus: "idle" as const,
    dataUpdatedAt: 0,
    refetch: () => Promise.resolve({ data }),
  };
}

export function useQuery(options: { queryKey: AnyKey; [k: string]: unknown }) {
  return answer(options.queryKey);
}

export function useQueries(options: { queries: { queryKey: AnyKey }[] }) {
  return options.queries.map((q) => answer(q.queryKey));
}

export function useMutation() {
  return {
    mutate: () => {},
    mutateAsync: () => Promise.resolve(undefined),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    data: undefined,
    reset: () => {},
  };
}

export function useInfiniteQuery(options: { queryKey: AnyKey }) {
  const data = FIXTURES[head(options.queryKey)];
  return {
    ...answer(options.queryKey),
    data: data ? { pages: [data], pageParams: [null] } : undefined,
    fetchNextPage: () => Promise.resolve(),
    hasNextPage: false,
    isFetchingNextPage: false,
  };
}
