/**
 * Under the edit bar while a tool other than Select is on (board 18), or a
 * line mode ("Edit stops", "Edit path"): which, and what the pointer does.
 * The mode's line is read for the map first: until it is, it says so.
 */
import { Box, Typography } from "@mui/material";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { modeStore } from "@/lib/explorer/edit/modeStore";

import { useAppSelector } from "@/hooks/store/ContextHooks";

import { ICON_GAP } from "@/components/explorer/SectionHeader";

export function ToolHint() {
  const { t } = useTranslation("common");
  const tool = useAppSelector((s) => s.explorer.edit.tool);
  const mode = useAppSelector((s) => s.explorer.edit.mode?.kind ?? null);
  const ready = useSyncExternalStore(modeStore.subscribe, modeStore.getSnapshot, () => null) !== null;
  const words =
    tool === "stop" || tool === "route"
      ? { name: t(`explorer_tool_${tool}`), hint: t(`explorer_tool_${tool}_hint`) }
      : mode
        ? {
            name: t(mode === "stops" ? "explorer_action_edit_stops" : "explorer_action_edit_path"),
            hint: ready ? t(`explorer_line_mode_${mode}_hint`) : t("explorer_calculating"),
          }
        : null;
  if (!words) return null;
  return (
    <Box
      role="status"
      sx={{
        mt: "8px",
        width: "fit-content",
        display: "flex",
        alignItems: "center",
        columnGap: ICON_GAP,
        height: 28,
        px: "12px",
        borderRadius: "14px",
        // As the bar's count once something changed: dark, on the map.
        bgcolor: "text.primary",
        color: "background.paper",
        boxShadow: "rgba(0, 0, 0, 0.2) 0px 0px 10px",
        pointerEvents: "none",
      }}>
      <Typography color="inherit" sx={{ fontSize: 12, fontWeight: 700 }}>
        {words.name}
      </Typography>
      <Typography color="inherit" sx={{ fontSize: 12, opacity: 0.85 }}>
        {words.hint}
      </Typography>
    </Box>
  );
}
