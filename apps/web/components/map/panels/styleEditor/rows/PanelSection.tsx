// A plain section of the panel (no accordion): a title with optional scope chip and add button, an optional note
// under it, the rows, or an empty text when there are none.
import { Box, IconButton, Typography } from "@mui/material";
import { Children, type ReactNode, memo } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

export interface PanelSectionProps {
  title: ReactNode;
  add?: { label: string; onClick: () => void };
  scope?: ReactNode;
  scopeNote?: ReactNode;
  empty?: ReactNode;
  children?: ReactNode;
}

export const PanelSection = memo(function PanelSection({
  title,
  add,
  scope,
  scopeNote,
  empty,
  children,
}: PanelSectionProps) {
  const hasRows = Children.toArray(children).length > 0;
  return (
    <Box
      component="section"
      sx={{
        px: 0,
        pt: 2.5,
        pb: 2,
        borderBottom: 1,
        borderColor: "divider",
        "&:last-of-type": { borderBottom: 0 },
      }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 3, pb: 0.5, minHeight: 28 }}>
        {/* The panels' section title (SectionHeader's label). */}
        <Typography
          component="h3"
          variant="body2"
          fontWeight="bold"
          color="text.secondary"
          sx={{ flex: 1, minWidth: 0 }}>
          {title}
        </Typography>
        {scope}
        {add && (
          <IconButton size="small" aria-label={add.label} onClick={add.onClick}>
            <Icon iconName={ICON_NAME.PLUS} sx={{ fontSize: 12 }} />
          </IconButton>
        )}
      </Box>
      {scopeNote && <Box sx={{ px: 3, pb: 1 }}>{scopeNote}</Box>}
      {hasRows ? (
        children
      ) : empty ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3 }}>
          {empty}
        </Typography>
      ) : null}
    </Box>
  );
});
