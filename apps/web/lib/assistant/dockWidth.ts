import { useSyncExternalStore } from "react";

/**
 * Width of the docked assistant panel. The user's chosen width is kept per
 * browser in localStorage; the width shown is that choice clamped to the
 * window, so a narrower window shrinks the panel without forgetting the choice.
 * Outside the dock state, which lives in sessionStorage per tab.
 */

const STORAGE_KEY = "goat:assistant-dock-width";

export const DOCK_DEFAULT_WIDTH = 400;
export const DOCK_MIN_WIDTH = 360;
/** One arrow key press on the resize handle. */
export const DOCK_WIDTH_STEP = 24;
/** The panel takes at most this share of the window. */
const MAX_SHARE = 0.5;

export const dockMaxWidth = (viewportWidth: number): number =>
  Math.max(DOCK_MIN_WIDTH, Math.floor(viewportWidth * MAX_SHARE));

export const clampDockWidth = (width: number, viewportWidth: number): number =>
  Math.round(Math.min(Math.max(width, DOCK_MIN_WIDTH), dockMaxWidth(viewportWidth)));

function readStored(): number | null {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStored(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // storage unavailable: the width holds until the page reloads
  }
}

/** undefined: not read from storage yet (read on first use, never during SSR). */
let chosen: number | null | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** The width the user chose, before clamping to the window. */
export function getChosenDockWidth(): number {
  if (chosen === undefined) chosen = readStored();
  return chosen ?? DOCK_DEFAULT_WIDTH;
}

/**
 * A new chosen width. A drag updates it on every frame with `persist: false`
 * and stores it once when it ends.
 */
export function setDockWidth(width: number, { persist = true }: { persist?: boolean } = {}): void {
  chosen = Math.round(width);
  if (persist) writeStored(chosen);
  notify();
}

/** Back to the default width, and nothing stored. */
export function resetDockWidth(): void {
  chosen = null;
  writeStored(null);
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("resize", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("resize", listener);
  };
};

/**
 * Read the dock width through `select(width, viewportWidth)`. The caller
 * re-renders only when the selected value changes, so a header that needs a
 * yes or no does not re-render on every frame of a drag.
 */
export function useDockWidthSelector<T extends string | number | boolean>(
  select: (width: number, viewportWidth: number) => T,
  serverValue: T
): T {
  return useSyncExternalStore(
    subscribe,
    () => select(clampDockWidth(getChosenDockWidth(), window.innerWidth), window.innerWidth),
    () => serverValue
  );
}

/** The panel's width now: the chosen width clamped to the window. Follows window resizes. */
export const useDockWidth = (): number => useDockWidthSelector((width) => width, DOCK_DEFAULT_WIDTH);

/** The window's width now, for the separator's maximum. */
export const useViewportWidth = (): number =>
  useDockWidthSelector((_width, viewportWidth) => viewportWidth, 0);

/** Tests: read the stored width again on next use. */
export function resetDockWidthStore(): void {
  chosen = undefined;
  notify();
}
