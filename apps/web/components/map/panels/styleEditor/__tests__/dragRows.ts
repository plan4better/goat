// A row of a class grid dragged with the pointer in jsdom, which lays nothing out: the rows are given the places a
// browser gives them (one under the other, 32 px each) so the sortable list can tell which row the pointer is over.
import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

const ROW = 32;

const rect = (top: number, height: number) =>
  ({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 300,
    bottom: top + height,
    width: 300,
    height,
    toJSON: () => ({}),
  }) as DOMRect;

/** Each class row 32 px under the one before, in the order of the page; their grid around them. */
function layOut() {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-class-row]"));
  rows.forEach((row, i) => {
    row.getBoundingClientRect = () => rect(24 + i * ROW, ROW);
  });
  for (const grid of new Set(rows.map((row) => row.parentElement))) {
    if (grid) grid.getBoundingClientRect = () => rect(0, 24 + rows.length * ROW);
  }
}

const centre = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

/** Lets effects run, and the time pass after which a drag's end lets clicks through again. */
async function settle(ms = 0) {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Presses `press` (a row or a control in it), moves the pointer in steps to the middle of row `onto`, and lets go;
 * `during` runs with the row still held over `onto` (a key pressed mid-drag). */
export async function dragRow(press: HTMLElement, onto: HTMLElement, during?: () => void) {
  layOut();
  const row = press.closest<HTMLElement>("[data-class-row]") ?? press;
  const from = centre(row);
  const to = centre(onto);
  const at = (y: number) => ({
    isPrimary: true,
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: 10,
    clientY: y,
  });
  fireEvent.pointerDown(press, at(from));
  await settle();
  for (const step of [0.25, 0.5, 0.75, 1]) {
    fireEvent.pointerMove(document, at(from + (to - from) * step));
    await settle();
  }
  if (during) {
    during();
    await settle();
  }
  fireEvent.pointerUp(document, at(to));
  await settle(60);
}
