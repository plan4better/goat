"use client";

// The grid of a class list (prototype 4.5), shared by a classification's classes and a raster's: a head naming the
// columns, then per class what it sets (a swatch, a value), a rule, the lower bound of manual breaks, the label, the
// count or share, show or hide, and "Style this class" where a class can be styled on its own. The head and the rows
// are subgrids of one grid, so values, labels and counts line up in columns; a number column keeps room for its
// longest value (`data-reserve`) and stands at the end of it, as in a table.
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  type PointerSensorOptions,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Box, Button, IconButton, type Theme, Typography } from "@mui/material";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/** The panel's color for a new class without one of its own, and for a raster's values without a class when they are
 * drawn. */
export const CATEGORY_GRAY = "#9aa3ad";

/** The keyboard focus mark of a row's buttons (its swatch, its label, the eye, a palette color's plus and bin): they
 * draw no ripple, MUI's only focus mark for them, so an outline as the icon tiles' shows. */
export const FOCUS_MARK = {
  "&.Mui-focusVisible": { outline: (theme: Theme) => `2px solid ${theme.palette.primary.main}` },
} as const;

/** The line between what the classes set and the values they cover. */
const Rule = () => <Box aria-hidden sx={{ alignSelf: "stretch", width: "1px", bgcolor: "divider" }} />;

/** Whether `target` is a text box (an input, a text area, an editable element). */
const isText = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");

/** The pointer that drags a row: the main button pressed anywhere on the row but in a text box, whose text a press
 * selects, or in a menu a control of the row opened (drawn elsewhere on the page). */
class RowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: event, currentTarget }: PointerEvent,
        { onActivation }: PointerSensorOptions
      ) => {
        const onRow = event.target instanceof Node && currentTarget.contains(event.target);
        if (!event.isPrimary || event.button !== 0 || !onRow || isText(event.target)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

/** A drag starts once the pointer has moved this far: a click on a row's label or swatch opens what it opens. */
const SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };
/** Up and down, inside the list. */
const MODIFIERS = [restrictToVerticalAxis, restrictToParentElement];

/** What a key press on a row's control asks: Alt with the up or down arrow moves the row one place. */
const stepOf = (event: KeyboardEvent) =>
  event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    ? event.key === "ArrowUp"
      ? -1
      : event.key === "ArrowDown"
        ? 1
        : 0
    : 0;

/** The controls of a row the keyboard reaches, in order. */
const FOCUSABLE = "button, input, textarea, select, [tabindex]:not([tabindex='-1'])";

/** What every row of a grid shares: whether it has a column of lower bounds, one for "Style this class", and how its
 * rows are reordered. */
const Columns = createContext<{
  bounds: boolean;
  styled: boolean;
  /** Moves the row at `from` by `step` places (the keyboard), where the grid's rows can be reordered. */
  move?: (from: number, step: number, row: HTMLElement) => void;
  /** The eye's names, translated once for all rows. */
  eye: { show: string; hide: string };
}>({
  bounds: false,
  styled: true,
  eye: { show: "", hide: "" },
});

export interface ClassGridProps {
  /** The columns' names: what the classes set (at the end of its column for numbers), the values they cover, the
   * count or share. */
  head: { value: string; label: string; count: string; valueAlign?: "start" | "end" };
  /** Manual breaks: a column of lower bounds before the labels. */
  bounds?: boolean;
  /** Whether the rows have a "Style this class" column (vector classes); false for a raster's. */
  styled?: boolean;
  /** Rows with an `index` can be dragged to another row's place, or moved one place with Alt and an arrow key: the
   * class at `from` moves to `to`. */
  onReorder?: (from: number, to: number) => void;
  /** How many classes the list has, where its rows can be reordered (those of a long list it leaves out too). */
  rows?: number;
  children: ReactNode;
}

export function ClassGrid({
  head,
  bounds = false,
  styled = true,
  onReorder,
  rows = 0,
  children,
}: ClassGridProps) {
  const { t } = useTranslation("common");
  const text = { variant: "caption", color: "text.secondary", noWrap: true } as const;
  const grid = useRef<HTMLDivElement | null>(null);
  // The latest handler, so what the rows read need not change with it (a list's handler closes over its items).
  const latest = useRef(onReorder);
  useEffect(() => {
    latest.current = onReorder;
  });
  const reorderable = !!onReorder;
  // The control that had the focus in a row moved by keyboard, given back to it at the row's new place.
  const [refocus, setRefocus] = useState<{ row: number; control: number } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    const row = grid.current?.querySelector(`[data-row-index="${refocus.row}"]`);
    row?.querySelectorAll<HTMLElement>(FOCUSABLE)[refocus.control]?.focus();
    setRefocus(null);
  }, [refocus]);
  const move = useCallback((from: number, step: number, row: HTMLElement) => {
    const to = from + step;
    // Only to a row the list shows (a long list sorts the rows it shows).
    if (!grid.current?.querySelector(`[data-row-index="${to}"]`)) return;
    const control = Array.from(row.querySelectorAll(FOCUSABLE)).indexOf(document.activeElement as Element);
    // A text box left first: what it holds is the class's at this place.
    if (isText(document.activeElement)) (document.activeElement as HTMLElement).blur();
    latest.current?.(from, to);
    if (control >= 0) setRefocus({ row: to, control });
  }, []);
  // The same while nothing changes for the rows: a memoised row draws again only for its own props.
  const columns = useMemo(
    () => ({
      bounds,
      styled,
      move: reorderable ? move : undefined,
      eye: { show: t("style_editor.show_class"), hide: t("style_editor.hide_class") },
    }),
    [bounds, styled, reorderable, move, t]
  );
  const sensors = useSensors(useSensor(RowPointerSensor, SENSOR_OPTIONS));
  const items = useMemo(() => Array.from({ length: rows }, (_, i) => String(i)), [rows]);
  // Escape during a drag cancels the drag only: marked as handled, the popovers around the list stay open.
  const settle = useRef<(() => void) | null>(null);
  const onDragStart = useCallback(() => {
    const handled = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", handled, true);
    settle.current = () => document.removeEventListener("keydown", handled, true);
  }, []);
  const stop = useCallback(() => {
    settle.current?.();
    settle.current = null;
  }, []);
  useEffect(() => stop, [stop]);
  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      stop();
      if (over && active.id !== over.id) latest.current?.(Number(active.id), Number(over.id));
    },
    [stop]
  );
  const content = <Columns.Provider value={columns}>{children}</Columns.Provider>;
  return (
    <Box
      ref={grid}
      sx={{
        display: "grid",
        gridTemplateColumns: `auto 1px ${bounds ? "auto " : ""}minmax(0, 1fr) auto auto${styled ? " auto" : ""}`,
        columnGap: 1,
        px: 3,
        "& [data-reserve]": { justifyContent: "flex-end" },
      }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "subgrid",
          gridColumn: "1 / -1",
          alignItems: "center",
          minHeight: 24,
        }}>
        <Typography {...text} sx={{ justifySelf: head.valueAlign ?? "start" }}>
          {head.value}
        </Typography>
        <Rule />
        <Typography {...text} title={head.label} sx={bounds ? { gridColumn: "span 2" } : undefined}>
          {head.label}
        </Typography>
        <Typography {...text} sx={{ justifySelf: "end" }}>
          {head.count}
        </Typography>
        <span />
        {styled && <span />}
      </Box>
      {reorderable ? (
        // The rows make room for the dragged one as it moves (the app's sortable lists).
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={MODIFIERS}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={stop}>
          <SortableContext items={items} strategy={verticalListSortingStrategy}>
            {content}
          </SortableContext>
        </DndContext>
      ) : (
        content
      )}
    </Box>
  );
}

/** A row of the grid saying how many rows a long list leaves out, which shows them. */
export function ClassGridMore({ hidden, onShow }: { hidden: number; onShow(): void }) {
  const { t } = useTranslation("common");
  return (
    <Box sx={{ gridColumn: "1 / -1", py: 0.5 }}>
      <Button variant="text" size="small" color="inherit" onClick={onShow} sx={{ px: 1, ml: -1 }}>
        {t("show_more_count", { count: hidden })}
      </Button>
    </Box>
  );
}

export interface ClassGridRowProps {
  /** What the class sets: its color swatch, value box or choice. */
  swatch: ReactNode;
  /** The class's lower bound (manual breaks, from the second class on); without one, the label takes its column. */
  bound?: ReactNode;
  /** The class's name box, or the button that opens its values. */
  label: ReactNode;
  /** Its count or share, as text. */
  count?: string;
  hidden?: boolean;
  /** Shows or hides the class (the eye); a row with `actions` has those in the eye's place instead. */
  onToggle?(): void;
  /** Controls in the eye's column (a palette color's plus and bin). */
  actions?: ReactNode;
  /** "Style this class", where the class can be styled on its own. */
  style?: ReactNode;
  /** A row the data has nothing for (Other, No data): it stands back. */
  absent?: boolean;
  title?: string;
  /** The class's place in its list, where the grid's rows can be reordered: the row can be dragged to another row's
   * place. */
  index?: number;
}

export function ClassGridRow(props: ClassGridRowProps) {
  const { move } = useContext(Columns);
  return move && props.index !== undefined ? (
    <SortableRow {...props} index={props.index} move={move} />
  ) : (
    <Cells {...props} />
  );
}

/** A row that can be reordered: dragged by a press anywhere on it but in a text box, or moved with Alt and an arrow
 * key from any of its controls (no stop of its own for the keyboard). A press anywhere in the list draws every row's
 * sortable state again (the list's drag starts), so the row's cells are memoised: they draw again for their own props
 * and when the row is picked up or let go. */
function SortableRow({
  move,
  ...props
}: ClassGridRowProps & { index: number; move: (from: number, step: number, row: HTMLElement) => void }) {
  const { index } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: String(index) });
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const step = stepOf(event);
      // A key in a menu a control of the row opened (drawn elsewhere on the page) is the menu's.
      if (!step || !event.currentTarget.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      move(index, step, event.currentTarget);
    },
    [index, move]
  );
  // Where the row stands while a row is dragged (making room, or the dragged one itself), set on its node: every row's
  // place changes as a drag starts and ends, and its cells need not draw for that.
  const node = useRef<HTMLElement | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      node.current = el;
      setNodeRef(el);
    },
    [setNodeRef]
  );
  useLayoutEffect(() => {
    if (!node.current) return;
    node.current.style.transform = CSS.Translate.toString(transform) ?? "";
    node.current.style.transition = transition ?? "";
  }, [transform, transition]);
  const sortable = useMemo(() => ({ setNodeRef: ref, listeners, onKeyDown }), [ref, listeners, onKeyDown]);
  return <Cells {...props} sortable={sortable} dragging={isDragging} />;
}

interface CellsProps extends ClassGridRowProps {
  /** What makes the row one that can be reordered: its node, its pointer and key handlers. */
  sortable?: {
    setNodeRef(node: HTMLElement | null): void;
    listeners?: Record<string, unknown>;
    onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  };
  dragging?: boolean;
}

const Cells = memo(function Cells({
  swatch,
  bound,
  label,
  count,
  hidden = false,
  onToggle,
  actions,
  style,
  absent,
  title,
  index,
  sortable,
  dragging = false,
}: CellsProps) {
  const { bounds, styled, eye } = useContext(Columns);
  return (
    // A row of the list's grid: every cell sits in its column, an empty one where the row has nothing there.
    <Box
      data-class-row
      data-absent={absent || undefined}
      title={title}
      {...(sortable
        ? {
            ref: sortable.setNodeRef,
            ...sortable.listeners,
            onKeyDown: sortable.onKeyDown,
            "data-row-index": index,
            "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
          }
        : {})}
      sx={{
        ...(sortable ? { cursor: "grab" } : {}),
        // The dragged row above the rows it passes.
        ...(dragging ? { position: "relative", zIndex: 1, cursor: "grabbing" } : {}),
        display: "grid",
        gridTemplateColumns: "subgrid",
        gridColumn: "1 / -1",
        alignItems: "center",
        minHeight: 32,
        opacity: hidden || absent ? 0.55 : 1,
        // The label of a row without a bound (the first class, Other, No data) takes the bound's column too.
        ...(bounds && !bound ? { "& > :nth-child(3)": { gridColumn: "span 2" } } : {}),
      }}>
      {swatch}
      <Rule />
      {bounds && bound ? bound : null}
      {label}
      {count !== undefined ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ justifySelf: "end", fontVariantNumeric: "tabular-nums" }}>
          {count}
        </Typography>
      ) : (
        <span />
      )}
      {actions ?? (
        <IconButton
          size="small"
          // No ripple: a long list draws hundreds of these, and a ripple mounts a second time after each.
          disableRipple
          aria-label={hidden ? eye.show : eye.hide}
          onClick={onToggle}
          sx={FOCUS_MARK}>
          <Icon iconName={hidden ? ICON_NAME.EYE_SLASH : ICON_NAME.EYE} sx={{ fontSize: 12 }} />
        </IconButton>
      )}
      {styled && (style ?? <span />)}
    </Box>
  );
});
