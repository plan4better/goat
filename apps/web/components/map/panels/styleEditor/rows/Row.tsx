// The panel row (prototype "srow"): an 84 px label column (the panel is 300 px wide), the value, inline actions such as the value mode button.
// A row without actions has no column for them, so its value ends where the actions of the other rows end.
import { Box, Typography, alpha } from "@mui/material";
import { type ReactNode, memo } from "react";

export const LABEL_WIDTH = 84;
export const ROW_HEIGHT = 48;

export interface RowProps {
  label?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  off?: boolean;
  active?: boolean;
}

export const Row = memo(function Row({ label, children, actions, note, off, active }: RowProps) {
  const hasActions = actions !== undefined && actions !== null && actions !== false;
  const columns = [label !== undefined && `${LABEL_WIDTH}px`, "minmax(0, 1fr)", hasActions && "auto"];
  return (
    <Box
      data-active={active || undefined}
      sx={{
        display: "grid",
        gridTemplateColumns: columns.filter(Boolean).join(" "),
        alignItems: "center",
        columnGap: 1.5,
        minHeight: ROW_HEIGHT,
        px: 3,
        opacity: off ? 0.55 : 1,
        // Edge to edge, as the layer list marks its selected row.
        bgcolor: (theme) => (active ? alpha(theme.palette.primary.main, 0.08) : "transparent"),
      }}>
      {label !== undefined && (
        <Typography variant="caption" color={active ? "primary" : "text.secondary"} noWrap>
          {label}
        </Typography>
      )}
      <Box sx={{ minWidth: 0, display: "flex", alignItems: "center", gap: 2 }}>{children}</Box>
      {hasActions && <Box sx={{ display: "flex", alignItems: "center" }}>{actions}</Box>}
      {note && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ gridColumn: label === undefined ? "1 / -1" : "2 / -1", pb: 1 }}>
          {note}
        </Typography>
      )}
    </Box>
  );
});
