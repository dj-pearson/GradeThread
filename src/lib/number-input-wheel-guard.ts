// Stop the mouse wheel from silently editing numbers.
//
// A focused `<input type="number">` treats a wheel event as increment/decrement
// in Chrome, Edge and Firefox. So a seller who clicks into a price, then scrolls
// the page to read the rest of the form, changes the price -- with the cursor
// still over the field, no click, no keystroke, and no visible cue that anything
// happened. The form saves whatever the wheel left behind.
//
// GradeThread has 164 `type="number"` inputs and most of them are money or
// measurements: bulk pricing, the composer's price, expense amounts, fee
// overrides, every garment measurement. These sit in long scrolling forms,
// which is exactly the shape that produces the bug.
//
// The fix is to blur the input while the wheel event is dispatching. The
// increment is the element's DEFAULT ACTION and only applies to a focused
// input, so removing focus first cancels it. Deliberately NOT
// `event.preventDefault()`: that would also stop the page scrolling under the
// cursor, trading a silent edit for a stuck page.
//
// Lives here rather than in components/ui/input.tsx because that directory is
// shadcn-generated and must not be hand-edited, and because plenty of these
// inputs are bare `<input>` elements rather than the wrapped component. One
// document-level listener covers both.

function isFocusedNumberInput(target: EventTarget | null): target is HTMLInputElement {
  return (
    target instanceof HTMLInputElement &&
    target.type === "number" &&
    target === target.ownerDocument.activeElement
  );
}

/**
 * Installs the guard on `document`. Idempotent-safe to call once at boot.
 * Returns a teardown so tests can remove it.
 */
export function installNumberInputWheelGuard(doc: Document = document): () => void {
  const onWheel = (event: Event) => {
    if (isFocusedNumberInput(event.target)) event.target.blur();
  };
  // Passive: the page must keep scrolling normally. We are cancelling the
  // input's default action by removing focus, not by cancelling the event.
  doc.addEventListener("wheel", onWheel, { passive: true });
  return () => doc.removeEventListener("wheel", onWheel);
}
