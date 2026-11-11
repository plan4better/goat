/**
 * A row of a menu-like popover (the header's popovers, an item's "…" menu,
 * a settings row's menu): one set of measures, so they read as one family.
 */
export const POPOVER_ROW_SX = {
  gap: "11px",
  p: "9px 10px",
  borderRadius: "8px",
  fontSize: 13.5,
  fontWeight: 600,
} as const;

/** The row's icon, drawn muted. */
export const POPOVER_ROW_ICON_SIZE = 15;

/** Around the rows, inside the card. */
export const POPOVER_LIST_PADDING = "6px";
