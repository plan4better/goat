/**
 * Leaving the Explorer with unsaved changes: whatever was about to happen —
 * closing it, opening another bundle's, switching away from the map — waits
 * here while the "Save changes to …?" dialog asks, then goes ahead after a
 * save or a discard, or is dropped by Keep editing.
 *
 * Held outside Redux because it is a function, not state; the dialog's being
 * open is Redux's (`edit.exit`).
 */
let pending: (() => void) | null = null;

/** Hold `proceed` until the dialog is answered. */
export function holdLeave(proceed: () => void): void {
  pending = proceed;
}

/** What was waiting, once: run it after a save or a discard. */
export function takeLeave(): (() => void) | null {
  const proceed = pending;
  pending = null;
  return proceed;
}
