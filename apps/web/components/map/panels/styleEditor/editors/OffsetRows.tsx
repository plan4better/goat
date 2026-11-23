"use client";

// An `[x, y]` offset in px (a label's, a marker image's) as two sliders, X and Y; `[0, 0]` writes nothing. In class
// scope it is the class's own. An offset by zoom has no sliders here: its rows stay away.
import { useTranslation } from "react-i18next";

import { SLIDERS } from "@/lib/style/editor/defaults";
import type { Path } from "@/lib/style/editor/store";

import { useEditor, useScoped } from "@/components/map/panels/styleEditor/context";
import { SliderRow } from "@/components/map/panels/styleEditor/rows";

export function OffsetRows({ base, rangeKey }: { base: Path; rangeKey: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { value: offset, writePath: path } = useScoped(`${base}.offset`);
  if (offset !== undefined && !Array.isArray(offset)) return null;
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
      />
    </>
  );
}
