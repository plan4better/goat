"use client";

// The colors of a raster file (prototype 3.3 to 3.5; spec 9.2 to 9.6): a color range opens its colors editor;
// hillshade shows its light and colors; categories list their classes.
import { useTranslation } from "react-i18next";

import { SLIDERS } from "@/lib/style/editor/defaults";
import { setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";

import { useEditor, useStyleValue } from "@/components/map/panels/styleEditor/context";
import {
  CategoriesEditor,
  useCategoryAdder,
} from "@/components/map/panels/styleEditor/editors/CategoriesEditor";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import {
  RasterColorsEditor,
  paletteStrip,
  renderColors,
} from "@/components/map/panels/styleEditor/editors/RasterColorsEditor";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, PanelSection, SliderRow } from "@/components/map/panels/styleEditor/rows";

const METHODS = ["standard", "multidirectional", "combined", "igor", "basic"];

function ColorsRow() {
  const { t } = useTranslation("common");
  const value = useStyleValue<unknown>("render");
  const render: JsonObject = isObject(value) ? value : {};
  const popover = usePopover();
  const next = useNextLevel();
  const terrain = render.type === "terrain";
  const colored = !terrain || render.palette !== undefined;
  const { colors, stepped } = renderColors(render);
  const classify = isObject(render.classify) ? render.classify : null;
  const text = !colored
    ? t("style_editor.hillshade_colors_off")
    : Array.isArray(render.stops)
      ? t("style_editor.colors_stops")
      : classify && Array.isArray(classify.classes)
        ? t("style_editor.raster_manual_n", { n: classify.classes.length })
        : t("style_editor.raster_method_continuous");
  const label = t("style_editor.colors");
  return (
    <NavRow
      label={label}
      value={text}
      swatch={
        colored ? { background: paletteStrip(colors, stepped) ?? "transparent", wide: true } : undefined
      }
      onOpen={(anchor) =>
        popover.open(next, {
          key: "raster:colors",
          title: terrain ? t("style_editor.hillshade_colors") : label,
          anchorTop: anchorTopOf(anchor),
          render: () => <RasterColorsEditor />,
        })
      }
    />
  );
}

function HillshadeRows() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const read = {
    method: useStyleValue<unknown>("render.method"),
    direction: useStyleValue<unknown>("render.direction"),
    altitude: useStyleValue<unknown>("render.altitude"),
    exaggeration: useStyleValue<unknown>("render.exaggeration"),
  } as Record<string, unknown>;
  const value = <T,>(key: string) => (read[key] ?? DEFAULTS[`terrain.${key}`]) as T;
  const setNumber = (key: string) => (v: number) =>
    store.update(
      (doc) => setIn(doc, `render.${key}`, v === DEFAULTS[`terrain.${key}`] ? undefined : v),
      `render.${key}`
    );
  const method = value<string>("method");
  return (
    <>
      <ChoiceRow<string>
        label={t("style_editor.hillshade_method")}
        value={method}
        options={METHODS.map((v) => ({
          value: v,
          label: t(`style_editor.hillshade_method_${v}`),
          sub: t(`style_editor.hillshade_method_${v}_sub`),
        }))}
        onChange={(v) => store.set("render.method", v === DEFAULTS["terrain.method"] ? undefined : v)}
      />
      <SliderRow
        label={t("style_editor.hillshade_direction")}
        {...SLIDERS["terrain.direction"]}
        value={value<number>("direction")}
        onChange={setNumber("direction")}
      />
      <SliderRow
        label={t("style_editor.hillshade_altitude")}
        {...SLIDERS["terrain.altitude"]}
        value={value<number>("altitude")}
        onChange={setNumber("altitude")}
      />
      <SliderRow
        label={t("style_editor.hillshade_strength")}
        {...SLIDERS["terrain.exaggeration"]}
        value={value<number>("exaggeration")}
        onChange={setNumber("exaggeration")}
      />
      <ColorRow
        label={t("style_editor.hillshade_shadow")}
        path="render.shadow_color"
        fallback={DEFAULTS["terrain.shadow_color"] as string}
      />
      <ColorRow
        label={t("style_editor.hillshade_highlight")}
        path="render.highlight_color"
        fallback={DEFAULTS["terrain.highlight_color"] as string}
      />
      {method === "standard" && (
        <ColorRow
          label={t("style_editor.hillshade_accent")}
          path="render.accent_color"
          fallback={DEFAULTS["terrain.accent_color"] as string}
        />
      )}
    </>
  );
}

export function RasterColorSection() {
  const { t } = useTranslation("common");
  // The type only: the rows read what they show, so a class edit does not render the section.
  const typeValue = useStyleValue<unknown>("render.type");
  const addCategory = useCategoryAdder();
  const type = typeof typeValue === "string" ? typeValue : "image";
  if (type === "image") return null;
  return (
    <PanelSection
      title={t(`style_editor.raster_type_${type}`)}
      add={
        type === "categorical"
          ? { label: t("style_editor.add_category"), onClick: () => addCategory(120) }
          : undefined
      }>
      {type === "categorical" ? (
        <CategoriesEditor />
      ) : (
        <>
          <ColorsRow />
          {type === "terrain" && <HillshadeRows />}
        </>
      )}
    </PanelSection>
  );
}
