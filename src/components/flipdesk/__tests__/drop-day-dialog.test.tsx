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
  spread: vi.fn(),
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
  useSpreadDrops: () => mutation(state.spread),
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
  state.spread = vi.fn(async ({ assignments }: { assignments: { id: string }[] }) => ({
    moved: assignments.length,
    unchanged: 0,
    failed: 0,
    movedIds: assignments.map((a) => a.id),
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
    button("Spread over time slots"),
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

describe("a time the clocks skip (SD-7)", () => {
  it("saves the moved time and says where the drop went", async () => {
    await render([drop("a", 3_600_000)]);
    await click(button("Reschedule Drop a"));
    const input = document.body.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      // Second Sunday of March 2030: 2:30 AM does not exist in Chicago.
      setter.call(input, "2030-03-10T02:30");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save"));
    expect(state.reschedule).toHaveBeenCalledWith({ id: "a", at: "2030-03-10T08:30:00.000Z" });
    expect(toastSpy.info).toHaveBeenCalledWith(
      "2:30 AM does not exist on this day in America/Chicago; set to 3:30 AM.",
    );
  });
});

describe("a reschedule that leaves the day (SD-10)", () => {
  it("toasts the new time with a Go to day action", async () => {
    const onDayChange = vi.fn();
    await render([drop("a", 3_600_000)], { onDayChange });
    await click(button("Reschedule Drop a"));
    const input = document.body.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "2030-06-14T19:00");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Save"));
    const [message, opts] = toastSpy.success.mock.calls[0]! as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toContain("Jun 14");
    expect(opts.action.label).toBe("Go to day");
    opts.action.onClick();
    expect(onDayChange).toHaveBeenCalledWith(2030, 6, 14);
  });
});

async function typeTime(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("undo and the time editor's keys (SD-11)", () => {
  it("Undo on an unschedule puts back the original instant", async () => {
    const d = drop("a", 5 * 3_600_000);
    await render([d]);
    await click(button("Unschedule Drop a"));
    expect(state.cancel).toHaveBeenCalledWith({ id: "a" });
    const [, opts] = toastSpy.success.mock.calls[0]! as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(opts.action.label).toBe("Undo");
    await act(async () => opts.action.onClick());
    expect(state.reschedule).toHaveBeenCalledWith({ id: "a", at: d.scheduled_publish_at });
  });

  it("offers no Undo when the old time has already passed", async () => {
    await render([drop("a", -3_600_000)]);
    await click(button("Unschedule Drop a"));
    const [, opts] = toastSpy.success.mock.calls[0]! as [string, { action?: unknown; description: string }];
    expect(opts.action).toBeUndefined();
    expect(opts.description).toContain("no undo");
  });

  it("Undo on a shift moves back only the rows that moved", async () => {
    await render([drop("a", 48 * 3_600_000), drop("b", 50 * 3_600_000)]);
    await click(button("+1 hour"));
    const call = toastSpy.success.mock.calls[toastSpy.success.mock.calls.length - 1]! as [
      string,
      { action: { onClick: () => void } },
    ];
    await act(async () => call[1].action.onClick());
    const undo = state.shift.mock.calls[state.shift.mock.calls.length - 1]![0] as {
      drops: { id: string }[];
      shift: { days?: number; minutes?: number };
    };
    expect(undo.drops.map((x) => x.id)).toEqual(["a", "b"]);
    expect(undo.shift).toEqual({ minutes: -60 });
  });

  it("Enter in the time input saves", async () => {
    await render([drop("a", 3_600_000)]);
    await click(button("Reschedule Drop a"));
    const input = await typeTime("2030-06-14T19:00");
    await act(async () => {
      input.form!.requestSubmit();
    });
    expect(state.reschedule).toHaveBeenCalledTimes(1);
  });

  it("Escape in the time input closes the editor and leaves the dialog open", async () => {
    const onOpenChange = vi.fn();
    await render([drop("a", 3_600_000)], { onOpenChange });
    await click(button("Reschedule Drop a"));
    const input = document.body.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(document.body.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("spread a day's drops over time slots (SD-14)", () => {
  async function setInput(label: string, value: string) {
    const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("writes three instants 15 minutes apart, the ones it previewed", async () => {
    await render([drop("a", 48 * 3_600_000), drop("b", 49 * 3_600_000), drop("c", 50 * 3_600_000), drop("d", 51 * 3_600_000)]);
    await click(button("Spread over time slots"));
    // Pick three of four.
    const d = document.body.querySelector<HTMLInputElement>('input[aria-label="Include Drop d"]')!;
    await act(async () => d.click());
    await click(button("15 min"));
    await setInput("Spread start time", "2030-06-14T19:00");
    const previewB = document.body.querySelector('[data-testid="spread-at-b"]')!.textContent;
    expect(previewB).toContain("to 7:15 PM");
    await click(button("Spread 3 drops"));
    expect(state.spread).toHaveBeenCalledTimes(1);
    const { assignments } = state.spread.mock.calls[0]![0] as { assignments: { id: string; at: string }[] };
    expect(assignments).toEqual([
      { id: "a", at: "2030-06-15T00:00:00.000Z" },
      { id: "b", at: "2030-06-15T00:15:00.000Z" },
      { id: "c", at: "2030-06-15T00:30:00.000Z" },
    ]);
    expect(toastSpy.success).toHaveBeenCalledWith("Spread 3 of 3.", expect.anything());
  });

  it("a past start disables the spread and says why", async () => {
    await render([drop("a", 48 * 3_600_000), drop("b", 49 * 3_600_000)]);
    await click(button("Spread over time slots"));
    await setInput("Spread start time", "2020-01-01T10:00");
    expect(button("Spread 2 drops").disabled).toBe(true);
    expect(document.body.textContent).toContain("That time has passed. Pick a later time.");
  });
});

describe("review fixes", () => {
  it("a partial shift still offers Undo, for only the rows that moved", async () => {
    state.shift = vi.fn(async () => ({ moved: 1, unchanged: 1, failed: 0, movedIds: ["a"] }));
    await render([drop("a", 48 * 3_600_000), drop("b", 50 * 3_600_000)]);
    await click(button("+1 hour"));
    const call = toastSpy.warning.mock.calls[0]! as [string, { action: { onClick: () => void } }];
    expect(call[0]).toContain("Shifted 1 of 2");
    await act(async () => call[1].action.onClick());
    const undo = state.shift.mock.calls[1]![0] as { drops: { id: string }[] };
    expect(undo.drops.map((x) => x.id)).toEqual(["a"]);
  });

  it("a drop the cron is publishing cannot be rescheduled, unscheduled or shifted", async () => {
    await render([
      drop("a", -60_000, { health: "publishing" }),
      drop("b", 5 * 3_600_000),
    ]);
    expect(button("Reschedule Drop a").disabled).toBe(true);
    expect(button("Unschedule Drop a").disabled).toBe(true);
    expect(button("Reschedule Drop b").disabled).toBe(false);
    await click(button("+1 day"));
    const arg = state.shift.mock.calls[0]![0] as { drops: { id: string }[] };
    expect(arg.drops.map((d) => d.id)).toEqual(["b"]);
  });
});
