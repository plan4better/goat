"use client";

// The zooms the layer shows at (spec 3.5): one range over 0 to 24; the ends mean no limit. Parts narrow it in their
// own editors.
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { setIn } from "@/lib/style/editor/store";

import {
  useEditor,
  useLiveMapZoom,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { ZoomRangeRow } from "@/components/map/panels/styleEditor/rows";

export function VisibleEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const mapZoom = useLiveMapZoom();
  const { geometry } = useStyleData();
  const from = useStyleValue<number | undefined>("min_zoom");
  const until = useStyleValue<number | undefined>("max_zoom");
  return (
    <>
      <ZoomRangeRow
        label={t("style_editor.zooms")}
        from={from}
        until={until}
        mapZoom={mapZoom}
        onChange={(min, max) =>
          store.update((doc) => setIn(setIn(doc, "min_zoom", min), "max_zoom", max), "layer.zooms")
        }
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, pt: 2 }}>
        {t(geometry ? "style_editor.visible_note_vector" : "style_editor.visible_note")}
      </Typography>
    </>
  );
}
