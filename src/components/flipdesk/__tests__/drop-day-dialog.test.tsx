// The drops day dialog, mounted with its mutations stubbed.
//
// SD-2: no button may quietly publish a drop early. A shift that would put
// every drop before the cron's five-minute window is not offered at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  role: "owner" as string,
  confirm: true,
  reschedule: vi.fn(),
  cancel: vi.fn(),
  shift: vi.fn(),
};

function mutation(fn: ReturnType<typeof vi.fn>) {
  return {
    mutateAsync: fn,
    mutate: fn,
    isPending: false,
    variables: undefined,
  };
}

vi.mock("@/hooks/use-scheduled-drops", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-scheduled-drops")>()),
  useRescheduleDrop: () => mutation(state.reschedule),
  useCancelDrop: () => mutation(state.cancel),
  useShiftDrops: () => mutation(state.shift),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => state.confirm,
}));

vi.mock("@/hooks/use-workspace", async () => {
  const perms = await import("@/lib/workspace-permissions");
  return {
    useWorkspace: () => ({
      role: state.role,
      can: (cap: Parameters<typeof perms.canDo>[1]) =>
        perms.canDo(state.role as Parameters<typeof perms.canDo>[0], cap),
    }),
  };
});

const toastSpy = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  });
  return fn;
});
vi.mock("sonner", () => ({ toast: toastSpy }));

const { DropDayDialog } = await import("@/components/flipdesk/drop-day-dialog");
type DayDrop = import("@/components/flipdesk/drop-day-dialog").DayDrop;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  state.role = "owner";
  state.confirm = true;
  state.reschedule = vi.fn(async () => undefined);
  state.cancel = vi.fn(async () => undefined);
  state.shift = vi.fn(async ({ drops }: { drops: { id: string }[] }) => ({
    moved: drops.length,
    unchanged: 0,
    failed: 0,
    movedIds: drops.map((d) => d.id),
  }));
  for (const k of ["success", "error", "warning", "info"] as const) toastSpy[k].mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

function drop(id: string, msFromNow: number, extra: Partial<DayDrop> = {}): DayDrop {
  return {
    id,
    inventory_item_id: `item-${id}`,
    scheduled_publish_at: new Date(Date.now() + msFromNow).toISOString(),
    listing_price: 20,
    title: `Drop ${id}`,
    promoted: false,
    health: "scheduled",
    healthNote: null,
    ...extra,
  };
}

async function render(drops: DayDrop[], props: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <DropDayDialog
          open
          onOpenChange={() => {}}
          dayLabel="September 25, 2026"
          drops={drops}
          timeZone="America/Chicago"
          {...props}
        />
      </MemoryRouter>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const b = Array.from(document.body.querySelectorAll("button")).find(
    (el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label,
  );
  if (!b) throw new Error(`no button ${label}`);
  return b as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

describe("shifts that would publish early (SD-2)", () => {
  it("disables Back 1 hour and Back 1 day when every drop is 30 minutes out", async () => {
    await render([drop("a", 30 * 60_000), drop("b", 35 * 60_000)]);
    expect(button("Back 1 hour").disabled).toBe(true);
    expect(button("Back 1 day").disabled).toBe(true);
    expect(button("+1 hour").disabled).toBe(false);
  });

  it("shifts only the future drops after the seller confirms a partial shift", async () => {
    await render([drop("a", 30 * 60_000), drop("b", 5 * 3_600_000)]);
    await click(button("Back 1 hour"));
    expect(state.shift).toHaveBeenCalledTimes(1);
    const arg = state.shift.mock.calls[0]![0] as { drops: { id: string }[] };
    expect(arg.drops.map((d) => d.id)).toEqual(["b"]);
  });

  it("shows the reason inline when the typed time has passed", async () => {
    await render([drop("a", 3_600_000)]);
    await click(button("Reschedule Drop a"));
    const input = document.body.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    expect(input.min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "2020-01-01T10:00");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save"));
    expect(state.reschedule).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("That time has passed. Pick a later time.");
  });
});

describe("each row says what the cron did (SD-4)", () => {
  it("shows the retry note on a retrying drop", async () => {
    await render([
      drop("a", 3_600_000, {
        health: "retrying",
        healthNote: "Retrying: attempt 3 of 5. Missing item specific: Brand",
      }),
    ]);
    expect(document.body.textContent).toContain("Retrying: attempt 3 of 5. Missing item specific: Brand");
  });
});

describe("roles without manage_inventory (SD-5)", () => {
  const drops = () => [drop("a", 48 * 3_600_000), drop("b", 49 * 3_600_000)];
  const writeButtons = () => [
    button("Reschedule Drop a"),
    button("Unschedule Drop a"),
    button("Reschedule Drop b"),
    button("Unschedule Drop b"),
    button("Back 1 day"),
    button("Back 1 hour"),
    button("+1 hour"),
    button("+1 day"),
  ];

  it("a viewer sees every write disabled and the role note", async () => {
    state.role = "viewer";
    await render(drops());
    for (const b of writeButtons()) expect(b.disabled, b.textContent ?? "").toBe(true);
    expect(document.body.textContent).toContain(
      "Only Manager access or higher can change drops.",
    );
  });

  it("an owner gets the buttons enabled and no note", async () => {
    await render(drops());
    for (const b of writeButtons()) expect(b.disabled, b.textContent ?? "").toBe(false);
    expect(document.body.textContent).not.toContain("can change drops");
  });
});
