// Minimal render harness for component tests: a real QueryClient (no retries,
// so a rejected read reaches isError on the first try) and a data router, with
// createRoot + act rather than a testing library the repo does not carry.
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export interface Mounted {
  container: HTMLDivElement;
  client: QueryClient;
  unmount: () => void;
}

export function mount(node: ReactNode, url = "/"): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = createMemoryRouter([{ path: "*", element: node }], {
    initialEntries: [url],
  });
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(
      h(QueryClientProvider, { client }, h(RouterProvider, { router })),
    );
  });
  return {
    container,
    client,
    unmount: () => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

export function buttonByText(
  root: ParentNode,
  text: string | RegExp,
): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((b) =>
    typeof text === "string"
      ? b.textContent?.trim() === text
      : text.test(b.textContent ?? ""),
  );
}
