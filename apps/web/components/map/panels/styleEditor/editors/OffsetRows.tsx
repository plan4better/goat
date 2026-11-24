"use client";

// An `[x, y]` offset in px (a label's, a marker image's) as two sliders, X and Y; `[0, 0]` writes nothing. In class
// scope it is the class's own. An offset by zoom has no sliders here: one row says so. Classes with an offset of their own
// keep it: the layer's sliders stay, with a note naming the classification (class scope shows each class's).
import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { SLIDERS } from "@/lib/style/editor/defaults";
import { classificationFor, keyOf, modeOf } from "@/lib/style/editor/forms";
import { summaryView } from "@/lib/style/editor/sources";
import { type Path, getIn } from "@/lib/style/editor/store";
import { isObject } from "@/lib/style/json";

import {
  useEditor,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
} from "@/components/map/panels/styleEditor/context";
import { PLAIN } from "@/components/map/panels/styleEditor/plainText";
import { Row, SliderRow } from "@/components/map/panels/styleEditor/rows";

export function OffsetRows({ base, rangeKey }: { base: Path; rangeKey: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields, geometry } = useStyleData();
  const scope = useScope();
  const fieldLabel = (name: string) => fields.find((f) => f.name === name)?.label ?? name;
  const { value: offset, writePath: path } = useScoped(`${base}.offset`);
  // How the offset varies as the scoped features draw it: by zoom (its stops) or by a classification's field.
  const varies = useStyleSelector((doc) => {
    const at = `${base}.offset`;
    const { doc: shown } = summaryView(doc, scope, at);
    const mode = modeOf(shown, at, geometry);
    if (mode === "zoom") {
      const value = getIn(shown, at);
      return `zoom:${isObject(value) && Array.isArray(value.zoom) ? value.zoom.length : 0}`;
    }
    if (mode === "classes") return `classes:${String(classificationFor(shown, keyOf(at), geometry)?.field)}`;
    return "";
  });
  if (varies.startsWith("zoom:"))
    return (
      <Row label={t("style_editor.offset")}>
        <Typography variant="body2" noWrap>
          {t("style_editor.by_zoom_stops", { count: Number(varies.slice("zoom:".length)) })}
        </Typography>
      </Row>
    );
  if (offset !== undefined && !Array.isArray(offset)) return null;
  const note = varies.startsWith("classes:")
    ? t("style_editor.offset_classes_note", { field: fieldLabel(varies.slice("classes:".length)), ...PLAIN })
    : undefined;
  const [x, y] = (Array.isArray(offset) ? offset : [0, 0]) as [number, number];
  const range = SLIDERS[rangeKey] ?? { min: -20, max: 20, step: 1, unit: "px" };
  const write = (next: [number, number]) =>
    store.set(path, next[0] === 0 && next[1] === 0 ? undefined : next);
  return (
    <>
      <SliderRow
        label={t("style_editor.offset_x")}
        min={range.min}
        max={range.max}
        step={range.step}
        unit={range.unit}
        value={x}
        onChange={(v) => write([v, y])}
      />
      <SliderRow
        label={t("style_editor.offset_y")}
        min={range.min}
        max={range.max}
        step={range.step}
        unit={range.unit}
        value={y}
        onChange={(v) => write([x, v])}
        note={note}
      />
    </>
  );
}
