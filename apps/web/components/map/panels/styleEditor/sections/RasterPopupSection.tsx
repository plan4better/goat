"use client";

// The popup of a raster file (spec 9.7): the vector layer's popup section over the cell's fields (the value, its
// class and every band), with the choice of the bands its default content shows for a file of several bands, and the
// unit the value shows with: the legend's (`legend.unit`, one value the legend's contents edit too). A map service's
// feature info comes later (spec 9.8).
import { useTranslation } from "react-i18next";

import { type JsonObject, isObject } from "@/lib/style/json";
import { valueBands } from "@/lib/style/raster/metadata";
import { rasterPopupRuleOf, rasterPopupWritten } from "@/lib/style/raster/popup";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { setLegendKey } from "@/components/map/panels/styleEditor/editors/LegendEditor";
import { ChoiceRow, TextRow } from "@/components/map/panels/styleEditor/rows";
import { PopupSection } from "@/components/map/panels/styleEditor/sections/PopupSection";

export function RasterPopupSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster, service } = useStyleData();
  const popup = useStyleValue<unknown>("popup");
  const render = useStyleValue<unknown>("render");
  const unit = useStyleValue<unknown>("legend.unit");
  if (service) return null;
  const style = store.document as unknown as JsonObject;
  const on = rasterPopupRuleOf(style) !== undefined;
  // A color scale's value reads with a unit; an image's bands have none, nor does content of one's own (blocks or
  // HTML), which the unit does not reach. Shading without colors has no legend for the unit to stand in too.
  const scale = isObject(render) && render.type !== undefined && render.type !== "image";
  const own = isObject(popup) && (Array.isArray(popup.blocks) || popup.mode === "html");
  const legendShows = isObject(render) && !(render.type === "hillshade" && render.palette == null);
  /** The popup with every band, or the styled ones (the default, left out). */
  const setBands = (all: boolean) => {
    const next: JsonObject = { ...(isObject(popup) ? popup : {}), bands: "all" };
    if (!all) delete next.bands;
    store.set("popup", rasterPopupWritten(style, next));
  };
  return (
    <PopupSection>
      {on && valueBands(raster?.info).length > 1 && (
        <ChoiceRow<string>
          label={t("style_editor.popup_values")}
          value={isObject(popup) && popup.bands === "all" ? "all" : "styled"}
          options={["styled", "all"].map((v) => ({
            value: v,
            label: t(`style_editor.popup_values_${v}`),
            sub: t(`style_editor.popup_values_${v}_sub`),
          }))}
          onChange={(v) => setBands(v === "all")}
        />
      )}
      {on && scale && !own && (
        <TextRow
          label={t("style_editor.legend_unit")}
          value={typeof unit === "string" ? unit : ""}
          placeholder={t("style_editor.legend_unit_placeholder")}
          note={t(legendShows ? "style_editor.popup_unit_note" : "style_editor.popup_unit_note_value")}
          onChange={(value) => setLegendKey(store, "unit", value || undefined)}
        />
      )}
    </PopupSection>
  );
}
