"use client";

// Holds the open popovers and draws them: level 1 left of the panel at the row that opened it, level 2 left of
// level 1, the picker next to its anchor. They are drawn in a portal, positioned from the panel's box, so the boxes
// that hold the panel on a page (scrolling, clipping) cannot cut them off. Only open popovers render their content.
// Escape closes the picker, then level 2, then level 1. A new scope (another layer or style) closes them all, and a
// picker closes when its control leaves the page.
import { Box, IconButton, Popper, type PopperProps, Typography } from "@mui/material";
import {
  type ReactNode,
  type RefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { FloatingPanel } from "@/components/common/FloatingPanel";
import {
  CLOSED,
  LevelContext,
  type OpenStack,
  OpenStackContext,
  type OpenStackStore,
  type PopoverApi,
  PopoverContext,
  type PopoverEntry,
  type PopoverLevel,
} from "@/components/map/panels/styleEditor/popovers/usePopover";

export const POPOVER_WIDTH = 320;
export const PICKER_WIDTH = 288;
const GAP = 12;
/** The popover's header sits this far above the row that opened it. */
const HEADER_OFFSET = 62;

const slot = (level: PopoverLevel) => String(level) as keyof OpenStack;

// Memoized: a frame renders again only when its entry or its content changes, not when another level opens or closes.
const PopoverFrame = memo(function PopoverFrame({
  entry,
  level,
  onClose,
  onBack,
  width,
  children,
}: {
  entry: PopoverEntry;
  level?: 1 | 2;
  onClose: () => void;
  /** Goes back to the editor this one replaced. */
  onBack?: () => void;
  width: number;
  children: ReactNode;
}) {
  const { t } = useTranslation("common");
  return (
    // The right panel's surface (FloatingPanel's glass, corners and shadow): a popover is a part of the panel.
    <Box
      data-popover-frame
      data-popover-level={level}
      sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <FloatingPanel width={width} minHeight={0} maxHeight="calc(100vh - 16px)">
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            pl: 3,
            pr: 2,
            pt: 3,
            pb: 1.5,
            flex: "none",
          }}>
          {onBack && entry.back && (
            <IconButton
              size="small"
              aria-label={t("style_editor.back_to", { title: entry.back.title })}
              title={t("style_editor.back_to", { title: entry.back.title })}
              onClick={onBack}
              sx={{ ml: -1.5 }}>
              <Icon iconName={ICON_NAME.CHEVRON_LEFT} sx={{ fontSize: 12 }} />
            </IconButton>
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body1" fontWeight="bold" noWrap>
              {entry.title}
            </Typography>
            {entry.subtitle && (
              <Typography component="p" variant="caption" noWrap color="text.secondary">
                {entry.subtitle}
              </Typography>
            )}
          </Box>
          {entry.actions}
          {/* The panels' header buttons (panels/Container.tsx): the close icon at their size; the header keeps its
              height. */}
          {entry.onDelete && (
            <IconButton aria-label={entry.onDelete.label} onClick={entry.onDelete.onClick} sx={{ my: -1 }}>
              <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 16 }} />
            </IconButton>
          )}
          <IconButton aria-label={t("style_editor.close")} onClick={onClose} sx={{ my: -1 }}>
            <Icon iconName={ICON_NAME.CLOSE} fontSize="small" />
          </IconButton>
        </Box>
        <Box
          data-popover-body
          sx={{
            overflowY: "auto",
            pb: 3,
            minHeight: 0,
            ...(entry.fill ? { display: "flex", flexDirection: "column" } : {}),
          }}>
          {children}
        </Box>
      </FloatingPanel>
    </Box>
  );
});

/** A picker's anchor: beside the popover (or the panel) that holds the control, at the control's height, so the
 * picker never covers the editor it belongs to. */
function besideFrame(el: HTMLElement) {
  return {
    contextElement: el,
    getBoundingClientRect: () => {
      const a = el.getBoundingClientRect();
      const frame = el.closest("[data-popover-frame]") ?? el.closest("[data-style-panel]");
      const left = frame ? frame.getBoundingClientRect().left : a.left;
      return {
        x: left,
        y: a.top,
        left,
        top: a.top,
        right: left,
        bottom: a.bottom,
        width: 0,
        height: a.height,
        toJSON: () => ({}),
      };
    },
  };
}

/** A picker beside its control, placed again whenever its size changes (a palette editor opening inside it, swatches
 * loading): otherwise it keeps the place it had for its first size until the next click, part of it off the window. */
function PickerPopper({
  anchorEl,
  children,
  zIndex = 1400,
}: {
  anchorEl: ReturnType<typeof besideFrame> | null;
  children: ReactNode;
  zIndex?: number;
}) {
  const popper = useRef<{ update(): unknown } | null>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => void popper.current?.update());
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  return (
    <Popper
      open
      anchorEl={anchorEl}
      popperRef={popper as PopperProps["popperRef"]}
      placement="left-start"
      modifiers={[
        { name: "offset", options: { offset: [0, GAP] } },
        // Clear of the window's edges by the gap the popovers keep.
        { name: "preventOverflow", options: { padding: GAP } },
      ]}
      sx={{ zIndex }}>
      <div ref={setBox}>{children}</div>
    </Popper>
  );
}

/**
 * A popover a picker opens from one of its controls (the marker's shape in the icon picker): left of the picker, at
 * the control's height, in the same frame. It belongs to the picker: it closes with it, on its close button, and when
 * its owner closes it.
 */
export function SidePopover({
  anchorEl,
  title,
  onClose,
  children,
}: {
  anchorEl: HTMLElement;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const anchor = useMemo(() => besideFrame(anchorEl), [anchorEl]);
  const entry = useMemo<PopoverEntry>(
    () => ({ key: `side:${title}`, title, anchorTop: 0, render: () => null }),
    [title]
  );
  return (
    <PickerPopper anchorEl={anchor} zIndex={1450}>
      <PopoverFrame entry={entry} width={PICKER_WIDTH} onClose={onClose}>
        {children}
      </PopoverFrame>
    </PickerPopper>
  );
}

/** A popover's top on the page: its header a little above the row that opened it, inside the window. */
const topFor = (pageTop: number) =>
  Math.max(
    GAP,
    Math.min(pageTop - HEADER_OFFSET, (typeof window === "undefined" ? 800 : window.innerHeight) - 360)
  );

/** Above the floating panels, below MUI's dialogs (the picker goes above those). */
const LEVEL_Z = 1250;

/** One popover in the portal, `offset` px left of the panel's left edge, at its row. */
function Placed({
  marker,
  offset,
  anchorTop,
  zIndex,
  children,
}: {
  marker: RefObject<HTMLSpanElement | null>;
  offset: number;
  anchorTop: number;
  zIndex: number;
  children: ReactNode;
}) {
  const [, redraw] = useState(0);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const onResize = () => redraw((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // The height the popover would have uncut: its box plus what its scrolling parts hide.
  useEffect(() => {
    if (!box) return;
    const measure = () => {
      let hidden = 0;
      box
        .querySelectorAll<HTMLElement>("[data-popover-body], [data-popover-scroll]")
        .forEach((el) => (hidden += el.scrollHeight - el.clientHeight));
      setHeight(box.offsetHeight + hidden);
    };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(box);
    const mutation = new MutationObserver(measure);
    mutation.observe(box, { childList: true, subtree: true });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [box]);
  const panel = marker.current?.closest("[data-style-panel]") ?? marker.current?.parentElement;
  const rect = panel?.getBoundingClientRect();
  const left = (rect?.left ?? 0) - offset;
  // At its row, moved up as far as it needs to end inside the window (as a picker is); taller than the window, it
  // starts at the top.
  const top = Math.max(
    GAP,
    Math.min(topFor((rect?.top ?? 0) + anchorTop), window.innerHeight - GAP - height)
  );
  return createPortal(
    // As tall as the room below its top: the frame scrolls inside it instead of running off the window.
    <div
      ref={setBox}
      style={{
        position: "fixed",
        left,
        top,
        zIndex,
        maxHeight: window.innerHeight - top - GAP,
        display: "flex",
        flexDirection: "column",
      }}>
      {children}
    </div>,
    document.body
  );
}

/** Provides usePopover to the panel and draws the open popovers; place it inside the panel's positioned box. A new
 * `scope` (the panel showing another layer or style) closes them all.
 *
 * Its children do not render again when a popover opens or closes: the API never changes, and the rows read the open
 * popovers through a store (useIsOpener, useIsOpen) that renders only the rows whose answer changes. Each popover's
 * content is drawn once per entry, so opening a picker leaves the editors under it as they are. */
export function PopoverProvider({ scope, children }: { scope?: unknown; children: ReactNode }) {
  const marker = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState<OpenStack>(CLOSED);
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setOpen(CLOSED);
  }
  // The stack as last committed, for the store's readers and `current`; its listeners hear of each new one.
  const openRef = useRef(open);
  const listeners = useRef(new Set<() => void>());
  const store = useMemo<OpenStackStore>(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
      get: () => openRef.current,
    }),
    []
  );
  useLayoutEffect(() => {
    if (openRef.current === open) return;
    openRef.current = open;
    listeners.current.forEach((listener) => listener());
  }, [open]);
  // The element last clicked (or activated by keyboard): a popover opened during that click records its button.
  const clicked = useRef<Element | null>(null);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      clicked.current = event.target instanceof Element ? event.target : null;
      setTimeout(() => (clicked.current = null));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const close = useCallback((level: PopoverLevel) => {
    setOpen((state) => {
      if (level === 1) return CLOSED;
      if (level === 2) return { ...state, "2": null, picker: null };
      return { ...state, picker: null };
    });
  }, []);
  const close1 = useCallback(() => close(1), [close]);
  const close2 = useCallback(() => close(2), [close]);
  const closePicker = useCallback(() => close("picker"), [close]);
  const back = useCallback(
    () => setOpen((state) => ({ ...state, "2": state["2"]?.back ?? null, picker: null })),
    []
  );

  const api = useMemo<PopoverApi>(
    () => ({
      open: (level, given) => {
        const opener = clicked.current?.closest("button, [role='button']") ?? null;
        const entry: PopoverEntry = { ...given, opener };
        setOpen((state) => {
          // An editor opened from inside the level 2 editor takes its place: it can go back to it (past a step on
          // the way, the field picker).
          const previous = state["2"];
          if (
            level === 2 &&
            previous &&
            previous.key !== entry.key &&
            clicked.current?.closest("[data-popover-level='2']")
          )
            entry.back = previous.transient ? previous.back : previous;
          if (state[slot(level)]?.key === entry.key) {
            if (level === 1) return CLOSED;
            if (level === 2) return { ...state, "2": null, picker: null };
            return { ...state, picker: null };
          }
          if (level === 1) return { "1": entry, "2": null, picker: null };
          if (level === 2) return { ...state, "2": entry, picker: null };
          return { ...state, picker: entry };
        });
      },
      close,
      current: (level) => openRef.current[slot(level)],
    }),
    [close]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const state = openRef.current;
      if (state.picker) close("picker");
      else if (state["2"]) close(2);
      else if (state["1"]) close(1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const level1 = open["1"];
  const level2 = open["2"];
  const picker = open.picker;
  const pickerElement = picker?.anchorEl;
  // A picker whose control left the page (its row turned into another, its part switched off, an undo) closes: it
  // would write to a value of another kind.
  useEffect(() => {
    if (!pickerElement) return;
    const observer = new MutationObserver(() => {
      if (!pickerElement.isConnected) close("picker");
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pickerElement, close]);
  const pickerAnchor = useMemo(() => (pickerElement ? besideFrame(pickerElement) : null), [pickerElement]);
  // Each entry's content, drawn once per entry: the editors read the store themselves.
  const content1 = useMemo(
    () => level1 && <LevelContext.Provider value={1}>{level1.render()}</LevelContext.Provider>,
    [level1]
  );
  const content2 = useMemo(
    () => level2 && <LevelContext.Provider value={2}>{level2.render()}</LevelContext.Provider>,
    [level2]
  );
  const contentPicker = useMemo(
    () => picker && <LevelContext.Provider value="picker">{picker.render()}</LevelContext.Provider>,
    [picker]
  );
  return (
    <PopoverContext.Provider value={api}>
      <span ref={marker} hidden />
      {/* Around the popovers too: a row in a popover can open the next level. */}
      <OpenStackContext.Provider value={store}>
        {children}
        {level1 && (
          <Placed marker={marker} offset={GAP + POPOVER_WIDTH} anchorTop={level1.anchorTop} zIndex={LEVEL_Z}>
            <PopoverFrame entry={level1} level={1} width={POPOVER_WIDTH} onClose={close1}>
              {content1}
            </PopoverFrame>
          </Placed>
        )}
        {level2 && (
          <Placed
            marker={marker}
            offset={2 * (GAP + POPOVER_WIDTH)}
            anchorTop={level2.anchorTop}
            zIndex={LEVEL_Z + 1}>
            <PopoverFrame
              entry={level2}
              level={2}
              width={POPOVER_WIDTH}
              onClose={close2}
              onBack={level2.back ? back : undefined}>
              {content2}
            </PopoverFrame>
          </Placed>
        )}
        {picker &&
          (picker.anchorEl ? (
            <PickerPopper anchorEl={pickerAnchor}>
              <PopoverFrame entry={picker} width={PICKER_WIDTH} onClose={closePicker}>
                {contentPicker}
              </PopoverFrame>
            </PickerPopper>
          ) : (
            <Placed marker={marker} offset={GAP + PICKER_WIDTH} anchorTop={picker.anchorTop} zIndex={1400}>
              <PopoverFrame entry={picker} width={PICKER_WIDTH} onClose={closePicker}>
                {contentPicker}
              </PopoverFrame>
            </Placed>
          ))}
      </OpenStackContext.Provider>
    </PopoverContext.Provider>
  );
}
