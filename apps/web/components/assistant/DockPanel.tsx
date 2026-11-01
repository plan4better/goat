"use client";

import { Box, useTheme } from "@mui/material";
import { keyframes } from "@mui/material/styles";
import {
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  DOCK_MIN_WIDTH,
  DOCK_WIDTH_STEP,
  clampDockWidth,
  dockMaxWidth,
  resetDockWidth,
  setDockWidth,
  useDockWidth,
  useViewportWidth,
} from "@/lib/assistant/dockWidth";

/** The panel's content arriving: it fades in from a little to the right. */
const enter = keyframes`
  from { opacity: 0; transform: translateX(12px); }
  to { opacity: 1; transform: none; }
`;

/**
 * The docked panel: an aside on the right of the page, as wide as the user
 * dragged it. Only this frame re-renders while the width changes; the
 * conversation inside is passed in as children and stays as it is.
 * `entrance`: the content comes in as the panel opens (not where the dock
 * replaces its loading frame, which came in already). Closing is instant.
 */
export default function DockPanel({
  label,
  busy = false,
  entrance = false,
  onDragOver,
  onDrop,
  children,
}: {
  label: string;
  /** Its content is still loading. */
  busy?: boolean;
  entrance?: boolean;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  children: ReactNode;
}) {
  const width = useDockWidth();
  return (
    <Box
      component="aside"
      data-assistant-dock=""
      aria-label={label}
      aria-busy={busy || undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
      sx={{
        // The panel takes its width at once and only its content moves: a growing width
        // would resize the map beside it on every frame.
        width,
        flexShrink: 0,
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        borderLeft: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
      }}>
      <ResizeHandle width={width} />
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          ...(entrance && {
            animation: `${enter} 180ms ease-out`,
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          }),
        }}>
        {children}
      </Box>
    </Box>
  );
}

type Drag = { startX: number; startWidth: number; next: number; moved: boolean; frame: number | null };

/**
 * The panel's left edge, as a window splitter: drag it, or focus it and use
 * the arrow keys (Home and End for the narrowest and widest). A double click
 * goes back to the default width.
 */
function ResizeHandle({ width }: { width: number }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const max = dockMaxWidth(useViewportWidth());
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);

  // While dragging, no text is selected and the cursor stays a resize cursor over the whole page.
  useEffect(() => {
    if (!dragging) return;
    const style = document.body.style;
    const previous = { userSelect: style.userSelect, cursor: style.cursor };
    style.userSelect = "none";
    style.cursor = "col-resize";
    return () => {
      style.userSelect = previous.userSelect;
      style.cursor = previous.cursor;
    };
  }, [dragging]);

  // Closed mid-drag: no frame may land after the panel is gone.
  useEffect(
    () => () => {
      if (drag.current?.frame != null) cancelAnimationFrame(drag.current.frame);
      drag.current = null;
    },
    []
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, next: width, moved: false, frame: null };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    // The panel is on the right: moving left makes it wider.
    current.next = clampDockWidth(current.startWidth + current.startX - event.clientX, window.innerWidth);
    current.moved ||= current.next !== current.startWidth;
    // One width per frame, however many pointer events arrive in between.
    if (current.frame === null) {
      current.frame = requestAnimationFrame(() => {
        current.frame = null;
        if (drag.current === current) setDockWidth(current.next, { persist: false });
      });
    }
  };

  const endDrag = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    setDragging(false);
    // A click without a move stores nothing: a width the window clamped stays the chosen one.
    if (current.moved) setDockWidth(current.next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowLeft: width + DOCK_WIDTH_STEP,
      ArrowRight: width - DOCK_WIDTH_STEP,
      Home: DOCK_MIN_WIDTH,
      End: max,
    };
    if (!Object.hasOwn(keys, event.key)) return;
    const next = keys[event.key];
    event.preventDefault();
    setDockWidth(clampDockWidth(next, window.innerWidth));
  };

  const pointerHandlers = { onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag };
  return (
    <>
      <Box
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t("assistant_resize")}
        aria-valuenow={width}
        aria-valuemin={DOCK_MIN_WIDTH}
        aria-valuemax={max}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        {...pointerHandlers}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={() => resetDockWidth()}
        sx={{
          // Centred on the panel's left border: 4px over the page, 4px over the panel.
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "-4px",
          width: "8px",
          zIndex: 3,
          cursor: "col-resize",
          touchAction: "none",
          outline: "none",
          "&::after": {
            content: '""',
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "3px",
            width: "2px",
            bgcolor: "transparent",
          },
          // Hovering shows the resize cursor only. The line shows while the pointer is pressed,
          // and for keyboard focus (not after a click, so not plain :focus).
          "&[data-dragging]::after, &:focus-visible::after": { bgcolor: theme.palette.primary.main },
        }}
      />
      {/* Over the whole window while dragging: the map canvas and embedded frames cannot take the
          pointer. It handles the drag too, should the browser not capture the pointer. */}
      {dragging && (
        <Box
          aria-hidden
          {...pointerHandlers}
          sx={{ position: "fixed", inset: 0, zIndex: theme.zIndex.tooltip + 1, cursor: "col-resize" }}
        />
      )}
    </>
  );
}
