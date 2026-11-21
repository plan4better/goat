// The panel's popovers: level 1 (a part's or section's editor), level 2 (an editor opened from level 1), level 3 and
// on (an editor opened from the level before), each beside the one that opened it, and a picker (color, palette,
// icon). One entry per level. What a control opens closes what its level opened before: the levels after its level and
// the picker. So only the path from the panel to the newest popover is open; a picker opened from the last level keeps
// it open.
import { type ReactNode, createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

/** A level from 1 on, or the picker. */
export type PopoverLevel = number | "picker";

export interface PopoverEntry {
  key: string;
  title: string;
  subtitle?: string;
  /** Shown in the header in place of the title: a control that names what the editor is of (a condition's field). */
  heading?: () => ReactNode;
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
}

export interface PopoverApi {
  open(level: PopoverLevel, entry: PopoverEntry): void;
  close(level: PopoverLevel): void;
  current(level: PopoverLevel): PopoverEntry | null;
}

/** The stack's own API: `open` is told the level of the control that opens (0: the panel). */
export interface PopoverStackApi extends Omit<PopoverApi, "open"> {
  open(level: PopoverLevel, entry: PopoverEntry, from: 0 | PopoverLevel): void;
}

export const PopoverContext = createContext<PopoverStackApi | null>(null);

/** The popover level a component renders in: 0 in the panel itself. */
export const LevelContext = createContext<0 | PopoverLevel>(0);

/** The popovers as a component sees them: what it opens, it opens from the level it renders in. */
export function usePopover(): PopoverApi {
  const stack = useContext(PopoverContext);
  const from = useContext(LevelContext);
  const api = useMemo<PopoverApi | null>(
    () => stack && { ...stack, open: (level, entry) => stack.open(level, entry, from) },
    [stack, from]
  );
  if (!api) throw new Error("usePopover needs a PopoverProvider");
  return api;
}

/** The open popovers: the levels in order (level 1 first) and the picker. */
export interface OpenStack {
  levels: PopoverEntry[];
  picker: PopoverEntry | null;
}

export const CLOSED: OpenStack = { levels: [], picker: null };

/** The open popovers as a store: a component subscribes to what it shows (whether its button opened one, whether one
 * with its key is open) and renders again only when that changes, not on every change of the stack. */
export interface OpenStackStore {
  subscribe(listener: () => void): () => void;
  get(): OpenStack;
}

const NO_STACK: OpenStackStore = { subscribe: () => () => undefined, get: () => CLOSED };

export const OpenStackContext = createContext<OpenStackStore>(NO_STACK);

const entriesOf = (stack: OpenStack) => [...stack.levels, stack.picker];

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

/** The key of the popover open at `level`; null while none is. */
export function useOpenKey(level: number): string | null {
  return useOpenStack((stack) => stack.levels[level - 1]?.key ?? null);
}

/** The panel each placed popover box belongs to: a page can show two panels with popovers (the style panel and the
 * View popover's Sky and atmosphere panel). */
const placedPanels = new WeakMap<Element, Element>();

/** Records the panel a placed popover box (marked `data-popover-placed`) belongs to. */
export function placeIn(box: Element, panel: Element): void {
  placedPanels.set(box, panel);
}

/** The panel box `el` measures against: the one it is in, the one its popover belongs to, else the first on the page. */
function panelOf(el: HTMLElement): Element | null {
  const own = el.closest("[data-style-panel]");
  if (own) return own;
  const placed = el.closest("[data-popover-placed]");
  return (placed && placedPanels.get(placed)) ?? document.querySelector("[data-style-panel]");
}

/** The top of `el` in the coordinates of the style panel box (marked `data-style-panel`). A control in a popover is
 * outside that box (popovers draw in a portal), so it measures against the panel its popover belongs to. */
export function anchorTopOf(el: HTMLElement): number {
  const top = el.getBoundingClientRect().top;
  const panel = panelOf(el);
  return panel ? top - panel.getBoundingClientRect().top : top;
}

/** Closes the popover this component draws in once `gone` holds: the value it edits is no longer of its kind (another
 * mode chosen, an undo). The editor that opened it stays. */
export function useCloseWhenGone(gone: boolean): void {
  const popover = usePopover();
  const level = useContext(LevelContext);
  useEffect(() => {
    if (gone && level !== 0) popover.close(level);
  }, [gone, level, popover]);
}

/** The level an editor opened from here takes: level 1 from the panel, the next level from a popover (beside it). */
export function useNextLevel(): number {
  const level = useContext(LevelContext);
  return level === 0 ? 1 : level === "picker" ? 2 : level + 1;
}
