import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScrollExperience } from "../scroll-experience";

/**
 * US-1962 hardening test — the epic's core promise is that the scroll experience
 * is pure progressive enhancement: inert under prefers-reduced-motion (and
 * no-JS), and it never loads the heavy Lenis+GSAP engine on a client that
 * shouldn't get it. jsdom ships neither matchMedia nor IntersectionObserver, so
 * we install controllable mocks to drive the provider's gates. Rendered with
 * react-dom/client + act so the mount effect actually runs.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function mockMatchMedia(matches: (query: string) => boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

class MockIntersectionObserver {
  observed: Element[] = [];
  constructor(public cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function installIO() {
  (
    window as unknown as { IntersectionObserver: unknown }
  ).IntersectionObserver = MockIntersectionObserver;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderWithEffects(ui: ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  document.documentElement.removeAttribute("data-scroll-enhanced");
  document.documentElement.style.removeProperty("--gt-scroll");
});

describe("ScrollExperience (progressive enhancement)", () => {
  it("is completely inert under prefers-reduced-motion", () => {
    mockMatchMedia((q) => q.includes("reduce"));
    installIO();

    renderWithEffects(
      <ScrollExperience>
        <div data-gt-reveal>content</div>
      </ScrollExperience>,
    );

    expect(
      document.documentElement.hasAttribute("data-scroll-enhanced"),
    ).toBe(false);
    const el = document.querySelector("[data-gt-reveal]")!;
    expect(el.classList.contains("gt-reveal-init")).toBe(false);
  });

  it("runs the cheap Tier-0 enhancement when motion is allowed", () => {
    // reduce:false + every capability query false → the Lenis+GSAP engine stays
    // gated off, so it is never dynamically imported here.
    mockMatchMedia(() => false);
    installIO();

    renderWithEffects(
      <ScrollExperience>
        <div data-gt-reveal>content</div>
      </ScrollExperience>,
    );

    expect(
      document.documentElement.hasAttribute("data-scroll-enhanced"),
    ).toBe(true);
    // The reveal FROM-state is applied by JS (so no-JS never hides content).
    const el = document.querySelector("[data-gt-reveal]")!;
    expect(el.classList.contains("gt-reveal-init")).toBe(true);
  });

  it("always renders the continuous-background layer and its children", () => {
    mockMatchMedia(() => false);
    installIO();

    const c = renderWithEffects(
      <ScrollExperience>
        <main data-testid="child">hello</main>
      </ScrollExperience>,
    );

    expect(c.querySelector(".gt-continuous-bg")).not.toBeNull();
    expect(c.querySelector('[data-testid="child"]')).not.toBeNull();
  });
});
