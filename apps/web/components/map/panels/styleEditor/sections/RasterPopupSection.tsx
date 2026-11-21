"use client";

// The popup of a raster file (spec 9.7): the vector layer's popup section over the cell's fields (the value, its
// class and every band), with the choice of the bands its default content shows for a file of several bands. A map
// service's feature info comes later (spec 9.8).
import { useTranslation } from "react-i18next";

import { type JsonObject, isObject } from "@/lib/style/json";
import { valueBands } from "@/lib/style/raster/metadata";
import { rasterPopupRuleOf, rasterPopupWritten } from "@/lib/style/raster/popup";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { ChoiceRow } from "@/components/map/panels/styleEditor/rows";
import { PopupSection } from "@/components/map/panels/styleEditor/sections/PopupSection";

export function RasterPopupSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster, service } = useStyleData();
  const popup = useStyleValue<unknown>("popup");
  useStyleValue("render");
  if (service) return null;
  const style = store.document as unknown as JsonObject;
  const on = rasterPopupRuleOf(style) !== undefined;
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
    </PopupSection>
  );
}
