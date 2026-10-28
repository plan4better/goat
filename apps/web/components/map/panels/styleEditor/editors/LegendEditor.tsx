"use client";

// What the legend shows (spec 7.2, prototype 4.9), with the legend as it will look on top: a caption, and per classification its place, whether it is in the
// legend, its heading and unit. The order is also the order the classifications apply in.
import { Box, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import type { Geometry } from "@/lib/style/compile/types";
import { moveClassification } from "@/lib/style/editor/classify";
import { type JsonObject, isObject } from "@/lib/style/json";
import { buildLegend, classificationProperty } from "@/lib/style/legend";

import { StyleLegend } from "@/components/map/legend/StyleLegend";
import {
  useEditor,
  useMapZoom,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { ChoiceRow, SwitchRow, TextRow } from "@/components/map/panels/styleEditor/rows";
import { useServiceLegendUrl } from "@/components/map/panels/styleEditor/sections/ServiceSection";

/** The legend as it will look; it follows every edit of what it draws, so it subscribes on its own. */
export function LiveLegend() {
  const store = useEditor();
  const { geometry, layerName } = useStyleData();
  const serviceLegendUrl = useServiceLegendUrl();
  const mapZoom = useMapZoom();
  useStyleValue("symbol");
  useStyleValue("classify");
  useStyleValue("legend");
  useStyleValue("render");
  const legend = buildLegend(store.document as unknown as JsonObject, {
    geometry,
    zoom: mapZoom,
    serviceLegendUrl,
  });
  return legend ? <StyleLegend legend={legend} layerName={layerName} /> : null;
}

export function LegendEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields, geometry } = useStyleData();
  const caption = useStyleValue<unknown>("legend.caption");
  const kind = useStyleValue<unknown>("kind");
  const legendText = (key: string) => {
    const value = store.get(`legend.${key}`);
    return typeof value === "string" ? value : "";
  };
  useStyleValue("legend");
  const all = useStyleValue<unknown>("classify");
  const classify = (Array.isArray(all) ? all : []).filter(isObject);
  // The geometry the legend reads its property words with.
  const legendGeometry = geometry ?? (store.get("geometry") as Geometry | undefined) ?? "point";
  const positionLabel = (i: number) =>
    i === 0
      ? t("style_editor.order_first")
      : i === classify.length - 1
        ? t("style_editor.order_last")
        : t("style_editor.order_position", { n: i + 1 });
  return (
    <>
      <LiveLegend />
      <TextRow
        label={t("style_editor.caption")}
        value={typeof caption === "string" ? caption : ""}
        placeholder={t("style_editor.caption_placeholder")}
        onChange={(value) => store.set("legend.caption", value || undefined)}
      />
      {kind === "raster" &&
        (["unit", "min_label", "max_label"] as const).map((key) => (
          <TextRow
            key={key}
            label={t(`style_editor.legend_${key}`)}
            value={legendText(key)}
            placeholder={t(`style_editor.legend_${key}_placeholder`)}
            onChange={(value) => store.set(`legend.${key}`, value || undefined)}
          />
        ))}
      {classify.map((c, ci) => {
        const fieldLabel = fields.find((f) => f.name === c.field)?.label ?? String(c.field ?? "");
        // Two classifications, often of one field, read "Size · field" as the legend titles them.
        const heading =
          classify.length > 1
            ? `${t(classificationProperty(c, legendGeometry))} · ${fieldLabel}`
            : fieldLabel;
        return (
          <Box key={typeof c.id === "string" ? c.id : ci} sx={{ pt: 2 }}>
            <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ px: 3 }}>
              {typeof c.title === "string" && c.title ? c.title : heading}
            </Typography>
            {classify.length > 1 && (
              <ChoiceRow<string>
                label={t("style_editor.order")}
                value={String(ci)}
                options={classify.map((_, i) => ({
                  value: String(i),
                  label: positionLabel(i),
                  sub: t("style_editor.order_sub"),
                }))}
                onChange={(to) => store.update((doc) => moveClassification(doc, ci, Number(to)))}
              />
            )}
            <SwitchRow
              label={t("style_editor.in_legend")}
              on={c.legend !== false}
              onToggle={() => store.set(`classify.${ci}.legend`, c.legend === false ? undefined : false)}
            />
            <TextRow
              label={t("style_editor.heading")}
              value={typeof c.title === "string" ? c.title : ""}
              placeholder={heading}
              onChange={(value) => store.set(`classify.${ci}.title`, value || undefined)}
            />
            <TextRow
              label={t("style_editor.unit")}
              value={typeof c.unit === "string" ? c.unit : ""}
              placeholder={t("style_editor.unit_placeholder")}
              onChange={(value) => store.set(`classify.${ci}.unit`, value || undefined)}
            />
          </Box>
        );
      })}
    </>
  );
}
