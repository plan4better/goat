"use client";

// The fill's pattern (spec 3.1): in the Fill editor a row with the pattern's picture and name that opens the pattern
// editor beside it; there the patterns as tiles and, for a pattern, its color, spacing and thickness, each fixed, by
// zoom or by classes like any other value.
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { classifyShape, scopedPart } from "@/lib/style/editor/classify";
import { modeOf } from "@/lib/style/editor/forms";
import type { Path } from "@/lib/style/editor/store";
import { choiceLabel, summarize } from "@/lib/style/editor/summaries";
import { isObject } from "@/lib/style/json";

import {
  useEditor,
  useMapZoom,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
} from "@/components/map/panels/styleEditor/context";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import { type PartRow, patternRows } from "@/components/map/panels/styleEditor/editors/partRows";
import { PatternPicture, PatternStops } from "@/components/map/panels/styleEditor/pickers/PatternTiles";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { NavRow } from "@/components/map/panels/styleEditor/rows";

/** The rows of the pattern editor that show: the patterns, and the rest once there is one. */
function PatternEditor({ base }: { base: Path }) {
  const { t } = useTranslation("common");
  const scope = useScope();
  const shown = useStyleSelector((doc) => {
    const part = scopedPart(doc, scope, "fill");
    const fill = isObject(part) ? part : {};
    const dots = fill.pattern === "dots" ? "dots" : "lines";
    return `${dots}:${patternRows(dots === "dots")
      .filter((row) => !row.when || row.when(fill))
      .map((row) => row.key)
      .join(",")}`;
  });
  const [kind, keys] = shown.split(":");
  const rows: PartRow[] = patternRows(kind === "dots").filter((row) => keys.split(",").includes(row.key));
  return (
    <>
      {rows.map((row) => (
        <PropertyRow key={row.key} row={row} base={base} />
      ))}
      {rows.length > 1 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, pt: 1 }}>
          {t("style_editor.pattern_note")}
        </Typography>
      )}
    </>
  );
}

/** The Fill editor's Pattern row: the pattern's picture and name (or how it varies), opening the pattern editor. */
export function PatternRow({ row, base }: { row: PartRow; base: Path }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const next = useNextLevel();
  const path = `${base}.${row.key}`;
  const { value } = useScoped(path);
  const label = t(row.label);
  // A classification of the pattern decides it, whatever the base's value.
  useStyleSelector((doc) => classifyShape(doc, data.geometry));
  const mode = modeOf(store.document, path, data.geometry);
  const text =
    mode === "fixed"
      ? choiceLabel(t, "fill.pattern", typeof value === "string" ? value : "none")
      : summarize(store.document, path, t, { fields: data.fields, mapZoom, geometry: data.geometry });
  return (
    <NavRow
      label={label}
      value={mode === "zoom" ? <PatternStops value={value} /> : text}
      glyph={
        mode === "fixed" && typeof value === "string" && value !== "none" ? (
          <PatternPicture kind={value} size={16} />
        ) : undefined
      }
      onOpen={(anchor) =>
        popover.open(next, {
          key: `pattern:${base}`,
          title: label,
          anchorTop: anchorTopOf(anchor),
          render: () => <PatternEditor base={base} />,
        })
      }
    />
  );
}
