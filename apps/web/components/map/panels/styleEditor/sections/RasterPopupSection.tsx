"use client";

// The popup of a raster file (spec 9.7): the cell values under the pointer, on click or while hovering; for several
// bands, the styled band or every band. A map service's feature info comes later (spec 9.8).
import { useTranslation } from "react-i18next";

import { setIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { ChoiceRow, PanelSection } from "@/components/map/panels/styleEditor/rows";

const SHOW_ON = ["off", "click", "hover"] as const;
const SHOW_ON_KEYS = { off: "popup_off", click: "popup_on_click", hover: "popup_on_hover" } as const;

export function RasterPopupSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster, service } = useStyleData();
  const popup = useStyleValue<unknown>("popup");
  if (service) return null;
  const record: JsonObject = isObject(popup) ? popup : {};
  const off = popup === false || record.enabled === false;
  const trigger = off ? "off" : record.trigger === "hover" ? "hover" : "click";
  /** The popup with `patch`; what equals the default (on, click, styled bands) stays out. */
  const write = (patch: JsonObject) =>
    store.update((doc) => {
      const next: JsonObject = { ...record, ...patch };
      for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
      delete next.enabled;
      return setIn(doc, "popup", Object.keys(next).length ? next : undefined);
    }, "popup");
  const label = t("style_editor.popup_show_on");
  return (
    <PanelSection title={t("style_editor.section_popup")}>
      <ChoiceRow<(typeof SHOW_ON)[number]>
        label={label}
        value={trigger}
        options={SHOW_ON.map((v) => ({
          value: v,
          label: t(`style_editor.${SHOW_ON_KEYS[v]}`),
          sub: t(`style_editor.raster_${SHOW_ON_KEYS[v]}_sub`),
        }))}
        onChange={(v) =>
          v === "off" ? store.set("popup", false) : write({ trigger: v === "click" ? undefined : v })
        }
      />
      {!off && (raster?.info?.bands ?? 1) > 1 && (
        <ChoiceRow<string>
          label={t("style_editor.popup_values")}
          value={record.bands === "all" ? "all" : "styled"}
          options={["styled", "all"].map((v) => ({
            value: v,
            label: t(`style_editor.popup_values_${v}`),
            sub: t(`style_editor.popup_values_${v}_sub`),
          }))}
          onChange={(v) => write({ bands: v === "all" ? "all" : undefined })}
        />
      )}
    </PanelSection>
  );
}
