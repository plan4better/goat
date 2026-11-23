"use client";

// A continuous palette's colors at the bottom of its editor (spec "Palettes"; with classes the class rows are the
// colors to edit, so there is no list), on the class lists' grid (`ClassGrid`): a head of Color and Value, a row per
// color with its swatch (clicked, the panel's color picker), where the color sits on the ramp (spread evenly over the
// range, read as the class lists' bound boxes read, with the unit; the hex where the ramp has no range, and as the
// row's tooltip), at the row's end a plus that adds a copy of the color after it and a bin as a stop has (shown on
// hover or focus, disabled at 12 and at 2 colors), rows dragged to another place as categories are, "Add a color" under
// the grid as "Add class" under the categories. An add, a removal or a move closes an open color picker of the list
// (colors have no identity of their own, a picker would write to what is at its place then); the focus of a control
// that goes or is disabled moves to a color of the list. The rows show the colors in the order they draw; the first edit of a catalogue palette writes them as
// an inline palette (2 to 12 colors), Reverse folded into the order. Each editor says where its palette lives and what
// an edit sets besides (`useSource`, a hook called with `args`), so the list and its color picker read the store
// themselves.
import { Box, ButtonBase, IconButton, Typography } from "@mui/material";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  PALETTE_MAX,
  PALETTE_MIN,
  addColorAfter,
  moveColor,
  recolor,
  removeColor,
} from "@/lib/style/editor/paletteList";
import { colorsIn, plainNumber } from "@/lib/style/editor/summaries";

import { useEditor } from "@/components/map/panels/styleEditor/context";
import { ClassGrid, ClassGridRow, FOCUS_MARK } from "@/components/map/panels/styleEditor/editors/ClassGrid";
import { ColorPicker } from "@/components/map/panels/styleEditor/pickers/ColorPicker";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { AddButton } from "@/components/map/panels/styleEditor/rows/AddButton";

/** Where a list's palette lives: its colors as they draw (`paletteList`), and how an edit is written. */
export interface PaletteSource {
  colors: string[];
  /** Writes the colors as the palette: an inline list, Reverse off. */
  write: (colors: string[]) => void;
  /** The value at `t` (0 to 1) along the ramp's range, where it has one: the rows name where their colors sit. */
  valueAt?: (t: number) => number;
  /** The unit after those values. */
  unit?: string;
}

export interface PaletteColorsProps<A> {
  /** Reads the palette from the store (a hook). */
  useSource: (args: A) => PaletteSource;
  args: A;
  /** Names the color pickers it opens. */
  pickerKey: string;
}

/** The color picker of color `index`, reading the palette as it is now. */
function PaletteColorPicker<A>({
  useSource,
  args,
  index,
}: Omit<PaletteColorsProps<A>, "pickerKey"> & { index: number }) {
  const store = useEditor();
  const { colors, write } = useSource(args);
  if (index >= colors.length) return null;
  return (
    <ColorPicker
      value={colors[index]}
      docColors={colorsIn(store.document)}
      onChange={(hex) => write(recolor(colors, index, hex))}
    />
  );
}

export function PaletteColors<A>({ useSource, args, pickerKey }: PaletteColorsProps<A>) {
  const { t, i18n } = useTranslation("common");
  const popover = usePopover();
  const { colors, write, valueAt, unit } = useSource(args);
  const full = colors.length >= PALETTE_MAX;
  const box = useRef<HTMLDivElement>(null);
  // The color whose swatch takes the focus once the list has drawn the change.
  const focusTo = useRef<number | null>(null);
  useEffect(() => {
    if (focusTo.current === null) return;
    const swatch = box.current?.querySelectorAll<HTMLElement>("[data-palette-swatch]")[focusTo.current];
    focusTo.current = null;
    swatch?.focus();
  });
  /** Writes `next`, closing this list's open color picker; `focusAt`: the color that takes the focus, where a control
   * of the list has it. */
  const change = (next: string[], focusAt?: number) => {
    if (popover.current("picker")?.key.startsWith(`${pickerKey}:color:`)) popover.close("picker");
    if (focusAt !== undefined && box.current?.contains(document.activeElement)) focusTo.current = focusAt;
    write(next);
  };
  // A plus or "Add a color" that fills the list is disabled: the new color takes the focus.
  const add = (after: number) =>
    change(addColorAfter(colors, after), colors.length + 1 >= PALETTE_MAX ? after + 1 : undefined);
  // Where color `i` sits: spread evenly over the range, as a palette's colors are; two decimals at most in the reader's
  // language, as the class lists' bound boxes.
  const placeOf = (i: number) => {
    if (!valueAt) return colors[i].toUpperCase();
    const v = valueAt(colors.length > 1 ? i / (colors.length - 1) : 0);
    return `${plainNumber(v, i18n.language)}${unit ? ` ${unit}` : ""}`;
  };
  return (
    <Box ref={box} role="group" aria-label={t("style_editor.palette")} sx={{ py: 1 }}>
      <ClassGrid
        head={{ value: t("style_editor.color"), label: t("style_editor.value"), count: "" }}
        styled={false}
        rows={colors.length}
        onReorder={(from, to) => change(moveColor(colors, from, to))}>
        {colors.map((color, i) => (
          <ClassGridRow
            key={i}
            index={i}
            title={color.toUpperCase()}
            swatch={
              <ButtonBase
                data-palette-swatch
                aria-label={t("style_editor.palette_color", { n: i + 1, hex: color })}
                onClick={(event) =>
                  popover.open("picker", {
                    key: `${pickerKey}:color:${i}`,
                    title: t("style_editor.palette_color_title", { n: i + 1 }),
                    anchorTop: anchorTopOf(event.currentTarget),
                    anchorEl: event.currentTarget,
                    render: () => <PaletteColorPicker useSource={useSource} args={args} index={i} />,
                  })
                }
                sx={{
                  width: 20,
                  height: 20,
                  flex: "none",
                  borderRadius: 0.5,
                  border: 1,
                  borderColor: "divider",
                  background: color,
                  ...FOCUS_MARK,
                }}
              />
            }
            label={
              <Typography variant="body2" noWrap sx={{ fontVariantNumeric: "tabular-nums" }}>
                {placeOf(i)}
              </Typography>
            }
            actions={
              // A plus that adds a copy of this color after it (disabled at 12 colors) and a stop's bin (disabled
              // while two are left), sized and spaced as a class row's eye and edit buttons, shown while the row is
              // pointed at or one of its controls has the focus.
              <Box
                data-row-actions
                sx={{
                  display: "flex",
                  justifyContent: "flex-end",
                  columnGap: 1,
                  opacity: 0,
                  transition: "opacity 120ms",
                  "[data-class-row]:hover > &, [data-class-row]:focus-within > &": { opacity: 1 },
                }}>
                <IconButton
                  size="small"
                  disableRipple
                  disabled={full}
                  aria-label={t("style_editor.add_color_after", { n: i + 1 })}
                  onClick={() => add(i)}
                  sx={FOCUS_MARK}>
                  <Icon iconName={ICON_NAME.PLUS} sx={{ fontSize: 12 }} />
                </IconButton>
                <IconButton
                  size="small"
                  disableRipple
                  disabled={colors.length <= PALETTE_MIN}
                  aria-label={t("style_editor.remove_color", { n: i + 1 })}
                  // The color that takes its place has the focus then (the one before it, for the last).
                  onClick={() => change(removeColor(colors, i), Math.min(i, colors.length - 2))}
                  sx={FOCUS_MARK}>
                  <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 12 }} />
                </IconButton>
              </Box>
            }
          />
        ))}
      </ClassGrid>
      <AddButton disabled={full} onClick={() => add(colors.length - 1)} sx={{ mt: 1, ml: 2 }}>
        {t("style_editor.add_color")}
      </AddButton>
    </Box>
  );
}
