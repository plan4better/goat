"use client";

// The grid of a class list (prototype 4.5), shared by a classification's classes and a raster's: a head naming the
// columns, then per class what it sets (a swatch, a value), a rule, the lower bound of manual breaks, the label, the
// count or share, show or hide, and "Style this class" where a class can be styled on its own. The head and the rows
// are subgrids of one grid, so values, labels and counts line up in columns; a number column keeps room for its
// longest value (`data-reserve`) and stands at the end of it, as in a table.
import { Box, IconButton, Typography } from "@mui/material";
import { type ReactNode, createContext, useContext } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

/** The panel's color for a new class without one of its own, and for a raster's values without a class when they are
 * drawn. */
export const CATEGORY_GRAY = "#9aa3ad";

/** The line between what the classes set and the values they cover. */
const Rule = () => <Box aria-hidden sx={{ alignSelf: "stretch", width: "1px", bgcolor: "divider" }} />;

/** What every row of a grid shares: whether it has a column of lower bounds, and one for "Style this class". */
const Columns = createContext({ bounds: false, styled: true });

export interface ClassGridProps {
  /** The columns' names: what the classes set (at the end of its column for numbers), the values they cover, the
   * count or share. */
  head: { value: string; label: string; count: string; valueAlign?: "start" | "end" };
  /** Manual breaks: a column of lower bounds before the labels. */
  bounds?: boolean;
  /** Whether the rows have a "Style this class" column (vector classes); false for a raster's. */
  styled?: boolean;
  children: ReactNode;
}

export function ClassGrid({ head, bounds = false, styled = true, children }: ClassGridProps) {
  const text = { variant: "caption", color: "text.secondary", noWrap: true } as const;
  return (
    <Box
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
      <Columns.Provider value={{ bounds, styled }}>{children}</Columns.Provider>
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
  hidden: boolean;
  onToggle(): void;
  /** "Style this class", where the class can be styled on its own. */
  style?: ReactNode;
  /** A row the data has nothing for (Other, No data): it stands back. */
  absent?: boolean;
  title?: string;
}

export function ClassGridRow({
  swatch,
  bound,
  label,
  count,
  hidden,
  onToggle,
  style,
  absent,
  title,
}: ClassGridRowProps) {
  const { t } = useTranslation("common");
  const { bounds, styled } = useContext(Columns);
  return (
    // A row of the list's grid: every cell sits in its column, an empty one where the row has nothing there.
    <Box
      data-class-row
      data-absent={absent || undefined}
      title={title}
      sx={{
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
      <IconButton
        size="small"
        aria-label={t(hidden ? "style_editor.show_class" : "style_editor.hide_class")}
        onClick={onToggle}>
        <Icon iconName={hidden ? ICON_NAME.EYE_SLASH : ICON_NAME.EYE} sx={{ fontSize: 12 }} />
      </IconButton>
      {styled && (style ?? <span />)}
    </Box>
  );
}
