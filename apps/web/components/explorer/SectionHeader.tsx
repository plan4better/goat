/**
 * A section's header across the Explorer's left panel: its icon, its name,
 * and at the right what it holds — a count, a note such as the day it shows —
 * and, for a section that lists things, a fold: the whole header opens it.
 */
import { Box, ButtonBase, Stack, Typography } from "@mui/material";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { shortDate } from "@/lib/explorer/format";

/** Side padding of the panel's rows (board 3). */
export const PX = 2.5;

/** The gap between a leading icon and its text, everywhere in the Explorer:
 * headers, labels, links and buttons alike (as MUI's buttons have it). */
export const ICON_GAP = "8px";

/** A checkbox (small) beside its words, the same everywhere: no padding of
 * its own (its row makes the click target), and its drawn box, 2.5 px in
 * from the icon's edge, taken as its edge. Its words then sit ICON_GAP
 * from the box, as text sits from an icon. */
export const CHECKBOX_SX = { p: 0, mx: "-2.5px" } as const;

export function SectionHeader({
  icon,
  label,
  amount,
  note,
  aside,
  folded,
  onFold,
  px = PX,
}: {
  /** A font icon, or a drawn marker such as the map's stop. */
  icon: ICON_NAME | ReactElement;
  label: string;
  /** A count, shown as a pill. */
  amount?: ReactNode;
  /** Plain text at the right. */
  note?: string;
  /** Anything else at the right, e.g. the date the figures are for. */
  aside?: ReactNode;
  folded?: boolean;
  onFold?: () => void;
  /** Side padding; 0 inside a section that is padded already. */
  px?: number;
}) {
  const { t } = useTranslation("common");
  const row = (
    <>
      {typeof icon === "string" ? (
        <Icon iconName={icon} style={{ fontSize: 14 }} htmlColor="inherit" />
      ) : (
        icon
      )}
      <Typography variant="body2" fontWeight="bold" noWrap sx={{ flex: 1, textAlign: "left" }}>
        {label}
      </Typography>
      {note && (
        <Typography variant="caption" color="text.secondary" noWrap>
          {note}
        </Typography>
      )}
      {aside}
      {amount !== undefined && (
        <Box
          component="span"
          sx={{
            px: 1,
            py: 0.25,
            borderRadius: 1,
            bgcolor: "action.hover",
            color: "text.secondary",
            fontSize: 12,
            fontWeight: 600,
          }}>
          {amount}
        </Box>
      )}
      {onFold && (
        <Box sx={{ display: "flex", width: 16, justifyContent: "center", color: "text.secondary" }}>
          <Icon
            iconName={folded ? ICON_NAME.CHEVRON_RIGHT : ICON_NAME.CHEVRON_DOWN}
            style={{ fontSize: 11 }}
          />
        </Box>
      )}
    </>
  );
  // A section that folds is opened by its whole header, not a small button.
  if (onFold)
    return (
      <ButtonBase
        onClick={onFold}
        aria-expanded={!folded}
        aria-label={folded ? t("explorer_unfold") : t("explorer_fold")}
        sx={{
          px,
          minHeight: 40,
          width: "100%",
          gap: ICON_GAP,
          justifyContent: "flex-start",
          flexShrink: 0,
          "&:hover": { bgcolor: "action.hover" },
        }}>
        {row}
      </ButtonBase>
    );
  return (
    <Stack direction="row" alignItems="center" spacing={ICON_GAP} sx={{ px, minHeight: 40 }}>
      {row}
    </Stack>
  );
}

/** The Explorer's date, set in the bottom bar, as a quiet label on each section its
 * figures depend on: every figure names its period (05-viewers-and-cost.md). */
export function DateChip({ date }: { date: string }) {
  const { i18n } = useTranslation("common");
  return (
    // A label, not a control: grey text with no ground or edge, so it is not
    // taken for a button (the date is set in the bottom bar).
    <Stack
      direction="row"
      alignItems="center"
      spacing={ICON_GAP}
      sx={{ color: "text.secondary", flexShrink: 0 }}>
      <Icon iconName={ICON_NAME.CALENDAR} style={{ fontSize: 11 }} htmlColor="inherit" />
      <Typography variant="caption" noWrap>
        {shortDate(date, i18n.language)}
      </Typography>
    </Stack>
  );
}

/** A panel's tabs (a line's Overview | Stops | Service | Calendar, a trip's
 * Stops | Calendar): sharing the row, in the panels' type. */
export const TAB_SX = {
  minHeight: 36,
  minWidth: 0,
  // Equal widths, whatever the labels.
  flex: "1 1 0",
  px: 3,
  textTransform: "none",
  fontSize: "0.8125rem",
} as const;
