// The panel's popovers: level 1 (a part's or section's editor), level 2 (an editor opened from level 1) and a
// picker (color, palette, icon, field). One entry per level; opening level 1 closes the others.
import { type ReactNode, createContext, useContext, useEffect, useSyncExternalStore } from "react";

export type PopoverLevel = 1 | 2 | "picker";

export interface PopoverEntry {
  key: string;
  title: string;
  subtitle?: string;
  /** The top of the row that opened it, in the panel's coordinates. */
  anchorTop: number;
  /** For pickers: the element they open next to. */
  anchorEl?: HTMLElement;
  render: () => ReactNode;
  onDelete?: { label: string; onClick(): void };
  /** Header controls such as a part's on/off switch; components that read the store themselves. */
  actions?: ReactNode;
  /** Set by the stack: the button whose click opened it, shown as expanded while it is open. */
  opener?: Element | null;
  /** The content is a column that scrolls a part of itself (a long class list) rather than all of it. */
  fill?: boolean;
  /** A step on the way to another editor (the field to classify by): going back skips it. */
  transient?: boolean;
  /** Set by the stack: the level 2 editor this one replaced, opened from inside it; its header goes back to it. */
  back?: PopoverEntry;
}

export interface PopoverApi {
  open(level: PopoverLevel, entry: PopoverEntry): void;
  close(level: PopoverLevel): void;
  current(level: PopoverLevel): PopoverEntry | null;
}

export const PopoverContext = createContext<PopoverApi | null>(null);

export function usePopover(): PopoverApi {
  const api = useContext(PopoverContext);
  if (!api) throw new Error("usePopover needs a PopoverProvider");
  return api;
}

/** The open popover of each level. */
export type OpenStack = Record<"1" | "2" | "picker", PopoverEntry | null>;

export const CLOSED: OpenStack = { "1": null, "2": null, picker: null };

/** The open popovers as a store: a component subscribes to what it shows (whether its button opened one, whether one
 * with its key is open) and renders again only when that changes, not on every change of the stack. */
export interface OpenStackStore {
  subscribe(listener: () => void): () => void;
  get(): OpenStack;
}

const NO_STACK: OpenStackStore = { subscribe: () => () => undefined, get: () => CLOSED };

export const OpenStackContext = createContext<OpenStackStore>(NO_STACK);

const entriesOf = (stack: OpenStack) => [stack["1"], stack["2"], stack.picker];

function useOpenStack<T>(select: (stack: OpenStack) => T): T {
  const store = useContext(OpenStackContext);
  const read = () => select(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Whether `el` opened a popover that is open now. */
export function useIsOpener(el: Element | null): boolean {
  return useOpenStack((stack) => el !== null && entriesOf(stack).some((entry) => entry?.opener === el));
}

/** Whether a popover with one of `keys` is open now, whichever control opened it. */
export function useIsOpen(...keys: string[]): boolean {
  return useOpenStack((stack) => entriesOf(stack).some((entry) => !!entry && keys.includes(entry.key)));
}

/** The top of `el` in the coordinates of the style panel box (marked `data-style-panel`). A control in a popover is
 * outside that box (popovers draw in a portal), so it measures against the panel on the page. */
export function anchorTopOf(el: HTMLElement): number {
  const top = el.getBoundingClientRect().top;
  const panel = el.closest("[data-style-panel]") ?? document.querySelector("[data-style-panel]");
  return panel ? top - panel.getBoundingClientRect().top : top;
}

/** The popover level a component renders in: 0 in the panel itself. */
export const LevelContext = createContext<0 | PopoverLevel>(0);

/** Closes the popover this component draws in once `gone` holds: the value it edits is no longer of its kind (another
 * mode chosen, an undo). The editor that opened it stays. */
export function useCloseWhenGone(gone: boolean): void {
  const popover = usePopover();
  const level = useContext(LevelContext);
  useEffect(() => {
    if (gone && level !== 0) popover.close(level);
  }, [gone, level, popover]);
}

/** The level an editor opened from here takes: level 1 from the panel, level 2 from a popover. */
export function useNextLevel(): 1 | 2 {
  return useContext(LevelContext) === 0 ? 1 : 2;
}
