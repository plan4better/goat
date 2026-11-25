"use client";

// The filter's area as a row of the panel: "Whole layer" while there is none, else its pieces in a line, with a
// switch, a remove button and, once the map has moved off a map view piece, a button that takes the current view.
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { FilterArea } from "@/lib/filter/area";

import { RowShell } from "@/components/map/panels/filter/RowShell";
import { areaSummary } from "@/components/map/panels/filter/area/pieces";
import { anchorTopOf } from "@/components/map/panels/styleEditor/popovers/usePopover";

/** The area's row among the panel's rows; a condition's id never is this one. */
export const AREA_ROW = "area";

export interface AreaRowProps {
  area: FilterArea | undefined;
  canEdit: boolean;
  /** Opens the area's picker; a row without it only says the area. */
  onOpen?: (anchorTop: number) => void;
  /** Switches the area on or off; no switch without it. */
  onToggle?: () => void;
  onRemove: () => void;
  /** Takes the current map view for the map view piece; given while the map is off it. */
  onUseView?: () => void;
  /** The names of the project's layers by dataset id: the row names the layer picked features are of. */
  layers?: ReadonlyMap<string, string>;
}

export const AreaRow = memo(function AreaRow({
  area,
  canEdit,
  onOpen,
  onToggle,
  onRemove,
  onUseView,
  layers,
}: AreaRowProps) {
  const { t } = useTranslation("common");
  const summary = useMemo(() => (area ? areaSummary(area, t, layers) : undefined), [area, t, layers]);
  const useView = t("filter_panel.area_use_view");
  return (
    <RowShell
      id={AREA_ROW}
      glyph={<Icon iconName={ICON_NAME.BOUNDING_BOX} sx={{ fontSize: 14, color: "text.secondary" }} />}
      title={summary}
      off={area && !area.enabled}
      canEdit={canEdit}
      onOpen={onOpen && ((anchor) => onOpen(anchorTopOf(anchor)))}
      // No area has nothing to switch or to remove.
      onToggle={area ? onToggle : undefined}
      onRemove={area ? onRemove : undefined}
      removeLabel={t("filter_panel.area_remove")}
      switchLabel={t("filter_panel.area_switch")}
      action={
        area &&
        onUseView && (
          <Tooltip title={useView}>
            <IconButton size="small" color="warning" aria-label={useView} onClick={onUseView}>
              <Icon iconName={ICON_NAME.REFRESH} sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        )
      }>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
        <Typography
          variant="body2"
          noWrap
          sx={{
            flex: 1,
            minWidth: 0,
            fontWeight: area ? 700 : 500,
            color: area ? undefined : "text.secondary",
          }}>
          {summary ?? t("filter_panel.area_whole")}
        </Typography>
        {!area && canEdit && onOpen && (
          <Icon iconName={ICON_NAME.CHEVRON_RIGHT} sx={{ fontSize: 10, color: "text.secondary" }} />
        )}
      </Box>
    </RowShell>
  );
});
