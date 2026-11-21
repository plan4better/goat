"use client";

// The Area section of the filter panel: the area's row, which opens its picker beside the panel, and under it what
// is going on with the area (a shape being drawn on the map, an outline that does not fit into the filter).
import { IconButton } from "@mui/material";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { editorKey } from "@/components/map/panels/filter/RowShell";
import { AreaDrawing, AreaNoteText } from "@/components/map/panels/filter/area/AreaNote";
import { AreaPicker } from "@/components/map/panels/filter/area/AreaPicker";
import { AREA_ROW, AreaRow } from "@/components/map/panels/filter/area/AreaRow";
import { useAreaTools } from "@/components/map/panels/filter/area/AreaTools";
import { viewPiece, viewPieceOf, viewStale, withPiece } from "@/components/map/panels/filter/area/pieces";
import { useMapView } from "@/components/map/panels/filter/area/useMapView";
import { useDraftArea, useFilterPanel } from "@/components/map/panels/filter/draft";
import { useIsOpen, useNextLevel, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { PanelSection } from "@/components/map/panels/styleEditor/rows";

const PICKER_KEY = editorKey(AREA_ROW);

/** The picker's remove button, in its header: there while there is an area. The header is outside the popover's
 * content, so it is told its level. */
function RemoveArea({ level }: { level: number }) {
  const { t } = useTranslation("common");
  const { area, setArea } = useAreaTools();
  const popover = usePopover();
  if (!area) return null;
  return (
    <IconButton
      aria-label={t("filter_panel.area_remove")}
      onClick={() => {
        popover.close(level);
        setArea(undefined);
      }}
      sx={{ my: -1 }}>
      <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 16 }} />
    </IconButton>
  );
}

export interface AreaSectionProps {
  canEdit: boolean;
  /** Whether the area can be switched off. */
  canSwitch: boolean;
}

export const AreaSection = memo(function AreaSection({ canEdit, canSwitch }: AreaSectionProps) {
  const { t } = useTranslation("common");
  const tools = useAreaTools();
  const { area, read: readArea, setArea } = tools;
  const popover = usePopover();
  const level = useNextLevel();
  const pickerOpen = useIsOpen(PICKER_KEY);
  // The map is only watched while there is a map view piece to compare it with.
  const view = viewPiece(area);
  const map = useMapView(canEdit && !!view, tools.map.id);
  const stale = !!view && !!map.bounds && viewStale(view.polygons, map.bounds);

  const open = useCallback(
    (anchorTop: number) =>
      popover.open(level, {
        key: PICKER_KEY,
        title: t("filter_panel.area"),
        anchorTop,
        render: () => <AreaPicker />,
        actions: <RemoveArea level={level} />,
      }),
    [popover, level, t]
  );
  const toggle = useCallback(() => {
    const now = readArea();
    if (now) setArea({ ...now, enabled: !now.enabled });
  }, [readArea, setArea]);
  const remove = useCallback(() => {
    if (popover.current(level)?.key === PICKER_KEY) popover.close(level);
    setArea(undefined);
  }, [popover, level, setArea]);
  const { read } = map;
  const useView = useCallback(() => {
    const now = readArea();
    const bounds = read();
    if (now && bounds) setArea(withPiece(now, viewPieceOf(bounds)));
  }, [readArea, setArea, read]);

  return (
    <PanelSection title={t("filter_panel.area")}>
      <AreaRow
        area={area}
        canEdit={canEdit}
        onOpen={open}
        onToggle={canSwitch ? toggle : undefined}
        onRemove={remove}
        onUseView={stale ? useView : undefined}
      />
      <AreaDrawing />
      {/* With the picker open the note is said there, beside the lists. */}
      {!pickerOpen && <AreaNoteText />}
    </PanelSection>
  );
});

/** Where no area can be set (a workflow step) a saved one still filters: it is said in a line and can be removed. */
export const SavedArea = memo(function SavedArea({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation("common");
  const { actions } = useFilterPanel();
  const area = useDraftArea();
  const remove = useCallback(() => actions.setArea(undefined), [actions]);
  if (!area) return null;
  return (
    <PanelSection title={t("filter_panel.area")}>
      <AreaRow area={area} canEdit={canEdit} onRemove={remove} />
    </PanelSection>
  );
});
