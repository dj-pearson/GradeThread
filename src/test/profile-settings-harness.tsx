// Shared render harness for the ProfileSettingsTab tests (avatar upload and
// save guards). Mocks are declared in each test file; this only mounts.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

export interface Mounted {
  container: HTMLDivElement;
  client: QueryClient;
  rerender: (el: ReactElement) => void;
  unmount: () => void;
}

export function mount(el: ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let root: Root | null = null;
  const wrap = (child: ReactElement) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{child}</MemoryRouter>
    </QueryClientProvider>
  );
  act(() => {
    root = createRoot(container);
    root.render(wrap(el));
  });
  return {
    container,
    client,
    rerender: (next) => act(() => root!.render(wrap(next))),
    unmount: () => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

export function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function buttonByText(container: HTMLElement, re: RegExp): HTMLButtonElement {
  const b = [...container.querySelectorAll("button")].find((el) =>
    re.test(el.textContent ?? ""),
  );
  if (!b) throw new Error(`button ${re} not rendered`);
  return b as HTMLButtonElement;
}

export async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
