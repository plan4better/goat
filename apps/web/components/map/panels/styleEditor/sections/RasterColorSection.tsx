"use client";

// The colors of a raster file (prototype 3.3 to 3.5; spec 9.2 to 9.6): a color range opens its colors editor;
// hillshade shows its light and colors; categories open their editor from a Colors row, as a classification's does.
// The colors start from the file's values, so they wait for its info.
import { useTranslation } from "react-i18next";

import { useLoadedRasterValues } from "@/lib/api/rasters";
import { SLIDERS } from "@/lib/style/editor/defaults";
import { setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { coverageUrl } from "@/lib/style/layerSource";
import { bandRange } from "@/lib/style/raster/metadata";
import { valueQuery, valuesUrl, verticalScale } from "@/lib/style/raster/values";

import {
  useEditor,
  useRasterWaiting,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { CategoriesRow } from "@/components/map/panels/styleEditor/editors/CategoriesEditor";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { paletteStrip, renderColors } from "@/components/map/panels/styleEditor/editors/RasterClassList";
import { RasterColorsEditor } from "@/components/map/panels/styleEditor/editors/RasterColorsEditor";
import { ResetToDataset } from "@/components/map/panels/styleEditor/popovers/ResetToDataset";
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
  const waiting = useRasterWaiting();
  const hillshade = render.type === "hillshade";
  const colored = !hillshade || render.palette !== undefined;
  const { colors, stepped } = renderColors(render);
  const classify = isObject(render.classify) ? render.classify : null;
  const method = classify && typeof classify.method === "string" ? classify.method : "manual";
  // The classes there are, or as many as the classification asks for while the server fills them.
  const n =
    (classify && Array.isArray(classify.classes) ? classify.classes.length : 0) ||
    (typeof classify?.count === "number" ? classify.count : 0);
  const text = !colored
    ? t("style_editor.hillshade_colors_off")
    : Array.isArray(render.stops)
      ? t("style_editor.colors_stops")
      : classify && n
        ? method === "manual"
          ? t("style_editor.raster_manual_n", { n })
          : t("style_editor.raster_classes_n", { method: t(`style_editor.method_${method}`), n })
        : t("style_editor.raster_method_continuous");
  const label = t("style_editor.colors");
  return (
    <NavRow
      label={label}
      value={text}
      disabled={waiting}
      swatch={
        colored ? { background: paletteStrip(colors, stepped) ?? "transparent", wide: true } : undefined
      }
      onOpen={(anchor) =>
        popover.open(next, {
          key: "raster:colors",
          title: hillshade ? t("style_editor.hillshade_colors") : label,
          anchorTop: anchorTopOf(anchor),
          actions: <ResetToDataset paths={["render"]} />,
          render: () => <RasterColorsEditor />,
        })
      }
    />
  );
}

function HillshadeRows() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const band = useStyleValue<unknown>("render.band");
  // Flat terrain is raised before it is shaded, by the range the map's values description gives (spec 9.6): the
  // description the map loaded, else the band's statistics (a band formula has none).
  const address = useStyleSelector((doc) => {
    const query = raster ? valueQuery(doc as unknown as JsonObject) : null;
    return raster && query ? valuesUrl(coverageUrl(raster.dataset), query) : undefined;
  });
  const described = useLoadedRasterValues(address);
  const raised = verticalScale(
    described?.range ??
      (typeof band === "object" && band !== null
        ? null
        : bandRange(raster?.info, typeof band === "number" ? band : 1))
  );
  const read = {
    method: useStyleValue<unknown>("render.method"),
    direction: useStyleValue<unknown>("render.direction"),
    altitude: useStyleValue<unknown>("render.altitude"),
    exaggeration: useStyleValue<unknown>("render.exaggeration"),
  } as Record<string, unknown>;
  const value = <T,>(key: string) => (read[key] ?? DEFAULTS[`hillshade.${key}`]) as T;
  const setNumber = (key: string) => (v: number) =>
    store.update(
      (doc) => setIn(doc, `render.${key}`, v === DEFAULTS[`hillshade.${key}`] ? undefined : v),
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
        onChange={(v) => store.set("render.method", v === DEFAULTS["hillshade.method"] ? undefined : v)}
      />
      <SliderRow
        label={t("style_editor.hillshade_direction")}
        {...SLIDERS["hillshade.direction"]}
        value={value<number>("direction")}
        onChange={setNumber("direction")}
      />
      <SliderRow
        label={t("style_editor.hillshade_altitude")}
        {...SLIDERS["hillshade.altitude"]}
        value={value<number>("altitude")}
        onChange={setNumber("altitude")}
      />
      <SliderRow
        label={t("style_editor.hillshade_strength")}
        {...SLIDERS["hillshade.exaggeration"]}
        value={value<number>("exaggeration")}
        note={raised > 1 ? t("style_editor.hillshade_raised", { k: raised }) : undefined}
        onChange={setNumber("exaggeration")}
      />
      <ColorRow
        label={t("style_editor.hillshade_shadow")}
        path="render.shadow_color"
        fallback={DEFAULTS["hillshade.shadow_color"] as string}
      />
      <ColorRow
        label={t("style_editor.hillshade_highlight")}
        path="render.highlight_color"
        fallback={DEFAULTS["hillshade.highlight_color"] as string}
      />
      {method === "standard" && (
        <ColorRow
          label={t("style_editor.hillshade_accent")}
          path="render.accent_color"
          fallback={DEFAULTS["hillshade.accent_color"] as string}
        />
      )}
    </>
  );
}

export function RasterColorSection() {
  const { t } = useTranslation("common");
  // The type only: the rows read what they show, so a class edit does not render the section.
  const typeValue = useStyleValue<unknown>("render.type");
  const type = typeof typeValue === "string" ? typeValue : "image";
  if (type === "image") return null;
  return (
    <PanelSection
      // Named after what it draws, as Draw as names it (a vector layer's Heatmap or Hexagons hold a Colors row too).
      title={t(`style_editor.raster_type_${type}`)}>
      {type === "categorical" ? (
        <CategoriesRow />
      ) : (
        <>
          <ColorsRow />
          {type === "hillshade" && <HillshadeRows />}
        </>
      )}
    </PanelSection>
  );
}
