import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import DragIndicator from "@mui/icons-material/DragIndicator";
import { Box, Chip, Divider, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ControlKey, ControlPositions, CornerKey } from "@/lib/validations/project";
import { CORNER_KEYS } from "@/lib/validations/project";

const CONFIGURABLE_CONTROLS: ControlKey[] = [
  "view",
  "location",
  "measure",
  "zoom_controls",
  "basemap",
  "fullscreen",
  "find_my_location",
  "project_info",
];

interface MapControlsLayoutProps {
  controlPositions: ControlPositions;
  onChange: (positions: ControlPositions) => void;
}

const SortableChip = ({
  id,
  label,
  onDelete,
}: {
  id: string;
  label: string;
  onDelete: () => void;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <Box
      ref={setNodeRef}
      sx={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
      }}>
      <Box
        {...attributes}
        {...listeners}
        sx={{ cursor: isDragging ? "grabbing" : "grab", display: "flex", alignItems: "center", touchAction: "none" }}>
        <DragIndicator sx={{ fontSize: 14, color: "text.disabled" }} />
      </Box>
      <Chip
        size="small"
        label={label}
        onDelete={onDelete}
        deleteIcon={<Close sx={{ fontSize: "12px !important" }} />}
        sx={{ fontSize: 12 }}
      />
    </Box>
  );
};

const MapControlsLayout = ({ controlPositions, onChange }: MapControlsLayoutProps) => {
  const { t } = useTranslation("common");
  const [menuState, setMenuState] = useState<{ anchor: HTMLElement; corner: CornerKey } | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const controlLabels: Record<ControlKey, string> = {
    location: t("search"),
    measure: t("measure"),
    view: t("view3d.control"),
    zoom_controls: t("zoom_controls"),
    basemap: t("basemap"),
    fullscreen: t("fullscreen"),
    find_my_location: t("find_my_location"),
    project_info: t("project_info"),
  };

  const corners: { key: CornerKey; label: string }[] = [
    { key: "top-left", label: t("top_left") },
    { key: "top-right", label: t("top_right") },
    { key: "bottom-right", label: t("bottom_right") },
  ];

  const getAvailable = (cornerKey: CornerKey): ControlKey[] =>
    CONFIGURABLE_CONTROLS.filter(
      (c) => !CORNER_KEYS.filter((k) => k !== cornerKey).some((k) => (controlPositions[k] ?? []).includes(c))
    );

  const handleDragEnd = (corner: CornerKey, event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const arr = controlPositions[corner] ?? [];
    const oldIdx = arr.indexOf(active.id as ControlKey);
    const newIdx = arr.indexOf(over.id as ControlKey);
    if (oldIdx === -1 || newIdx === -1) return;
    onChange({ ...controlPositions, [corner]: arrayMove(arr, oldIdx, newIdx) });
  };

  const handleAdd = (control: ControlKey, corner: CornerKey) => {
    onChange({ ...controlPositions, [corner]: [...(controlPositions[corner] ?? []), control] });
  };

  const handleRemove = (corner: CornerKey, control: ControlKey) => {
    onChange({ ...controlPositions, [corner]: (controlPositions[corner] ?? []).filter((c) => c !== control) });
  };

  return (
    <>
      <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
        <Stack spacing={0} divider={<Divider />}>
          {corners.map(({ key: cornerKey, label }) => {
            const assigned = controlPositions[cornerKey] ?? [];
            const available = getAvailable(cornerKey);
            return (
              <Box key={cornerKey} sx={{ px: 1.5, py: 1 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Typography variant="caption" color="text.secondary">
                    {label}
                  </Typography>
                  {available.length > 0 && (
                    <Tooltip title={t("add")} placement="top">
                      <IconButton
                        size="small"
                        onClick={(e) => setMenuState({ anchor: e.currentTarget, corner: cornerKey })}
                        sx={{ p: 0.25 }}>
                        <Add sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>

                {assigned.length > 0 && (
                  <DndContext sensors={sensors} onDragEnd={(e) => handleDragEnd(cornerKey, e)}>
                    <SortableContext items={assigned} strategy={horizontalListSortingStrategy}>
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 0.75 }}>
                        {assigned.map((control) => (
                          <SortableChip
                            key={control}
                            id={control}
                            label={controlLabels[control]}
                            onDelete={() => handleRemove(cornerKey, control)}
                          />
                        ))}
                      </Box>
                    </SortableContext>
                  </DndContext>
                )}
              </Box>
            );
          })}
        </Stack>
      </Box>

      <Menu
        anchorEl={menuState?.anchor}
        open={Boolean(menuState)}
        onClose={() => setMenuState(null)}>
        {menuState &&
          getAvailable(menuState.corner).map((control) => (
            <MenuItem
              key={control}
              dense
              onClick={() => {
                handleAdd(control, menuState.corner);
                setMenuState(null);
              }}>
              {controlLabels[control]}
            </MenuItem>
          ))}
      </Menu>
    </>
  );
};

export default MapControlsLayout;
