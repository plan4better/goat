"use client";

// The lines under an area's list, picker or section: the shape being drawn or edited on the map, and the last outline
// that did not fit into the filter.
import { Box, Button, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { useAreaTools } from "@/components/map/panels/filter/area/AreaTools";

/** How far an outline's edges move, in meters below a kilometer (at least 10 m: "up to" is said), else kilometers. */
const shiftText = (meters: number, language: string) =>
  meters < 1000
    ? new Intl.NumberFormat(language, { style: "unit", unit: "meter", maximumFractionDigits: 0 }).format(
        Math.max(10, Math.round(meters / 10) * 10)
      )
    : new Intl.NumberFormat(language, { style: "unit", unit: "kilometer", maximumFractionDigits: 1 }).format(
        meters / 1000
      );

/** What became of the last outline, where it was picked: why it was left out, or the question whether to add it
 * simplified. `from` is the list it was picked in; without it, the note of a shape or the map view. */
export function AreaNoteText({ from, px = 3 }: { from?: string; px?: number }) {
  const { t, i18n } = useTranslation("common");
  const { note, confirm, dismiss } = useAreaTools();
  if (!note || note.from !== from) return null;
  if (note.kind === "refused")
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", px, pb: 1 }}>
        {t("filter_panel.area_over_limit")}
      </Typography>
    );
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <Box sx={{ px, pb: 2 }}>
      <Typography variant="caption" color="text.secondary" component="p">
        {t("filter_panel.area_simplify_question", {
          points: number.format(note.points),
          kept: number.format(note.kept),
          shift: shiftText(note.shift, i18n.language),
        })}
      </Typography>
      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 1 }}>
        <Button variant="text" size="small" onClick={dismiss}>
          {t("cancel")}
        </Button>
        <Button variant="contained" size="small" onClick={confirm}>
          {t("filter_panel.area_add_simplified")}
        </Button>
      </Box>
    </Box>
  );
}

/** While a shape is drawn or edited on the map: what to do there, and a way out; an edit can also be finished here. */
export function AreaDrawing() {
  const { t } = useTranslation("common");
  const { drawing, editing, cancelDraw, finishEdit } = useAreaTools();
  if (!drawing && !editing) return null;
  const text = editing
    ? editing.kind === "shape" && editing.center
      ? "filter_panel.area_editing_circle"
      : "filter_panel.area_editing"
    : drawing === "point"
      ? "fetch_features_area_pick_on_map"
      : "filter_panel.area_drawing";
  return (
    // The longer edit hint takes the line, its buttons going under it on the right.
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 2, px: 3, minHeight: 32 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        aria-live="polite"
        sx={{ flex: 1, minWidth: 0, flexBasis: editing ? "100%" : 0 }}>
        {t(text)}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, mr: -2, ml: "auto" }}>
        <Button variant="text" size="small" onClick={cancelDraw} sx={{ minWidth: 0 }}>
          {t("cancel")}
        </Button>
        {editing && (
          <Button variant="text" size="small" onClick={finishEdit} sx={{ minWidth: 0 }}>
            {t("done")}
          </Button>
        )}
      </Box>
    </Box>
  );
}
