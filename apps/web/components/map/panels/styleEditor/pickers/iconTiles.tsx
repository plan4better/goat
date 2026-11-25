"use client";

// The pieces the icon picker's tabs share: square tiles in a grid, group headings, the search field.
import {
  Box,
  InputAdornment,
  OutlinedInput,
  type SxProps,
  type Theme,
  Typography,
  alpha,
} from "@mui/material";
import { type ReactNode, memo, useLayoutEffect, useRef, useState } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { fieldSx } from "@/components/map/panels/styleEditor/rows/fieldBox";

/** The height of a pane under the tabs: its search, its bars and its list. */
export const PANE_HEIGHT = 360;
/** A pane's scrolling list: what the pane's search and bars leave of its height. */
export const PANE_LIST = { flex: "1 1 0", minHeight: 0, overflowY: "auto" } as const;
export const TILE = 36;

/** The look of the tiles inside a container (TileGrid, the tone row): one style for all of them. */
export const tileStyles: SxProps<Theme> = {
  "& .goat-icon-tile": {
    width: TILE,
    height: TILE,
    p: 0,
    m: 0,
    border: 0,
    borderRadius: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    bgcolor: "transparent",
    color: "inherit",
    cursor: "pointer",
    "&:hover": { bgcolor: "action.hover" },
    "&:focus-visible": { outline: (theme) => `2px solid ${theme.palette.primary.main}` },
    "&[aria-pressed='true']": {
      bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12),
      // Inside the tile: an outline would be clipped where the tile meets the list's edge.
      boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.primary.main}`,
    },
  },
};

/** One icon to pick: a plain square button named after it, marked while selected; TileGrid styles every tile at
 * once, so a grid of a thousand emoji stays quick to draw. */
export const IconTile = memo(function IconTile({
  label,
  selected,
  onClick,
  children,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="goat-icon-tile"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onClick}>
      {children}
    </button>
  );
});

/** A tile's row in a grid: the tile and the gap under it. */
export const ROW = TILE + 4;
/** Tiles a row before a list has been measured: what the picker's width holds. */
const COLUMNS = 7;

/** Tiles in rows that fill the pane's width. With `count`, a grid of a long list: it takes the height of all its
 * rows and holds the tiles of rows `first` on (the children), so only the rows near view are drawn. */
export function TileGrid({
  children,
  count,
  cols = COLUMNS,
  first = 0,
}: {
  children: ReactNode;
  count?: number;
  cols?: number;
  first?: number;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, ${TILE}px)`,
        gridAutoRows: TILE,
        alignContent: "start",
        justifyContent: "space-between",
        rowGap: `${ROW - TILE}px`,
        boxSizing: "border-box",
        ...tileStyles,
      }}
      // Inline: every grid has its own height, so none adds a style rule.
      style={
        count === undefined
          ? undefined
          : { height: Math.max(0, Math.ceil(count / cols) * ROW - (ROW - TILE)), paddingTop: first * ROW }
      }>
      {children}
    </Box>
  );
}

export function PaneHeading({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "text.secondary",
        pt: 3,
        pb: 1,
      }}>
      {children}
    </Typography>
  );
}

/** Rows drawn beyond the list's edges, so a scroll shows drawn tiles. */
const OVERSCAN = 4 * ROW;
/** The rows drawn change in steps of this many, so a scroll of a few pixels draws nothing new. */
const STEP = 4;

/** Which rows of each group to draw: from the first to before the last; every row while the list has no height (not
 * laid out). */
interface Drawn {
  cols: number;
  all: boolean;
  rows: ReadonlyMap<string, readonly [number, number]>;
}

const sameDrawn = (a: Drawn | null, b: Drawn) =>
  !!a &&
  a.cols === b.cols &&
  a.all === b.all &&
  a.rows.size === b.rows.size &&
  [...b.rows].every(([id, [first, last]]) => a.rows.get(id)?.[0] === first && a.rows.get(id)?.[1] === last);

/** A pane's list of groups, each a box of its heading and its tiles. The group in view shows its heading above the
 * list, in place of the first group's heading in it: the list's edge cuts off the tiles scrolling up, so the heading
 * needs no background (the picker's surface is translucent; no fill would match it). The list must be positioned, so
 * a group's offsets are its place in the list.
 *
 * Only the rows near view are drawn (`rows`, for a TileGrid with `count`): every grid has the height of all its rows,
 * so the groups' places are known before their tiles are drawn. `reveal`, a tile by its group and index, is scrolled
 * into view once, when the list is first laid out with it: the list opens on the selected icon. */
export function usePaneGroups(ids: readonly string[], reveal?: { id: string; index: number } | null) {
  const list = useRef<HTMLDivElement | null>(null);
  const groups = useRef(new Map<string, HTMLElement>());
  const [current, setCurrent] = useState("");
  const shown = useRef(current);
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const drawnNow = useRef(drawn);
  const revealed = useRef(false);
  // Where a group's tiles start: its heading in the list sits above them.
  const tilesTop = (group: HTMLElement) =>
    (group.lastElementChild as HTMLElement | null)?.offsetTop ?? group.offsetTop;
  const draw = (next: Drawn) => {
    if (sameDrawn(drawnNow.current, next)) return;
    drawnNow.current = next;
    setDrawn(next);
  };
  const update = () => {
    const box = list.current;
    if (!box) return;
    const height = box.clientHeight;
    const laidOut = [...groups.current].filter(([, group]) => group.offsetHeight);
    const width = (laidOut[0]?.[1].lastElementChild as HTMLElement | null)?.clientWidth;
    const cols = width ? Math.max(1, Math.floor(width / TILE)) : COLUMNS;
    const before = drawnNow.current;
    // Other columns than the grids were drawn with change every grid's height: the groups' places are measured once
    // the grids have them.
    if (height && cols !== (before?.cols ?? COLUMNS)) {
      draw({ cols, all: false, rows: before && !before.all ? before.rows : new Map() });
      return;
    }
    const target = reveal ? groups.current.get(reveal.id) : undefined;
    if (height && reveal && !revealed.current && target?.offsetHeight) {
      revealed.current = true;
      const top = tilesTop(target);
      const row = Math.floor(reveal.index / cols) * ROW;
      // The group's start when that shows the tile (as the group's button in the bar would), else the tile's row in
      // the middle of the list.
      box.scrollTo({ top: row + TILE <= height ? top : top + row - (height - TILE) / 2 });
    }
    const scrolled = box.scrollTop;
    let next = ids[0] ?? "";
    for (const id of ids) {
      const group = groups.current.get(id);
      // Only a group laid out (none is while the list is hidden).
      if (group?.offsetHeight && tilesTop(group) <= scrolled + 1) next = id;
    }
    if (next !== shown.current) setCurrent((shown.current = next));
    if (!height) {
      draw({ cols: COLUMNS, all: true, rows: new Map() });
      return;
    }
    const rows = new Map(before?.all ? [] : before?.rows);
    for (const [id, group] of laidOut) {
      const grid = group.lastElementChild as HTMLElement | null;
      if (!grid) continue;
      const top = tilesTop(group);
      const total = Math.ceil(grid.offsetHeight / ROW);
      const from = Math.floor((scrolled - OVERSCAN - top) / ROW / STEP) * STEP;
      const to = Math.ceil((scrolled + height + OVERSCAN - top) / ROW / STEP) * STEP;
      const first = Math.max(from, 0);
      const last = Math.min(to, total);
      rows.set(id, first < last ? [first, last] : [0, 0]);
    }
    draw({ cols, all: false, rows });
  };
  // After every render too: a search or a new recent emoji moves the groups without a scroll.
  useLayoutEffect(update);
  return {
    list,
    current: ids.includes(current) ? current : (ids[0] ?? ""),
    onScroll: update,
    /** Tiles a row. */
    cols: drawn?.cols ?? COLUMNS,
    /** The rows of the group to draw, from the first to before the last; none before the list is measured (a new
     * pair each time: pass its numbers on, not the pair). */
    rows: (id: string): readonly [number, number] =>
      drawn?.all ? [0, Infinity] : (drawn?.rows.get(id) ?? [0, 0]),
    /** Scrolls the group's tiles to the list's top, its heading above the list. */
    jump: (id: string) => {
      const group = groups.current.get(id);
      if (group && list.current) list.current.scrollTo({ top: tilesTop(group) });
      setCurrent((shown.current = id));
      update();
    },
    ref: (id: string) => (element: HTMLElement | null) => {
      if (element) groups.current.set(id, element);
      else groups.current.delete(id);
    },
  };
}

export function PaneSearch({
  label,
  value,
  onChange,
  end,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  end?: ReactNode;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 3, pt: 2 }}>
      <OutlinedInput
        size="small"
        fullWidth
        value={value}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
        inputProps={{ "aria-label": label }}
        startAdornment={
          <InputAdornment position="start">
            <Icon iconName={ICON_NAME.SEARCH} sx={{ fontSize: 14 }} />
          </InputAdornment>
        }
        sx={fieldSx}
      />
      {end}
    </Box>
  );
}

export function PaneEmpty({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" color="text.secondary" sx={{ py: 6, textAlign: "center" }}>
      {children}
    </Typography>
  );
}
