"use client";

// General for raster files (prototype 3.1, 3.2; spec 9): how the cells are drawn, which band, and which bands make
// the picture. Switching to a color range starts from the band's values (the raster service's statistics) or the
// file's type; a file the service cannot read says so here.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { type RasterRenderType, defaultRender, drawAsOptions, equalClasses } from "@/lib/style/editor/raster";
import { setIn } from "@/lib/style/editor/store";
import { isObject } from "@/lib/style/json";
import { seedDomain } from "@/lib/style/raster/metadata";

import {
  useEditor,
  useRasterSample,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { drawAsIcon } from "@/components/map/panels/styleEditor/drawAsIcons";
import { ChoiceRow, PanelSection } from "@/components/map/panels/styleEditor/rows";

/** The image adjustments (spec 9.1), only for images. */
export const ADJUSTMENTS = ["brightness", "contrast", "saturation", "hue"] as const;
const TRUE_COLOR = [1, 2, 3];
const FALSE_COLOR = [4, 1, 2];

const same = (a: unknown, b: number[]) =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

export function RasterGeneralSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const sample = useRasterSample();
  // Each key on its own: `render` also holds the classes, which this section does not show.
  const typeValue = useStyleValue<unknown>("render.type");
  const bandValue = useStyleValue<unknown>("render.band");
  const bandsValue = useStyleValue<unknown>("render.bands");
  const [custom, setCustom] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const type = (typeof typeValue === "string" ? typeValue : "image") as RasterRenderType;
  const info = raster?.info;
  const band = typeof bandValue === "number" ? bandValue : 1;
  const options = drawAsOptions(info);
  if (!options.includes(type)) options.push(type);

  /** A range from the band's values, unless the user wrote one meanwhile. */
  const seedFromData = async (forBand: number, kind: RasterRenderType) => {
    const found = await sample(forBand);
    if (!found || !info) return;
    const now = store.get("render");
    if (!isObject(now) || now.type !== kind) return;
    if (kind === "categorical" && !Array.isArray(now.classes)) {
      store.set("render.classes", defaultRender("categorical", { info, sample: found }).classes);
    }
    if (kind === "continuous" || kind === "terrain") {
      const domain = seedDomain(found, info);
      if (!domain) return;
      store.update((doc) => {
        let next = setIn(doc, "render.domain", domain);
        const classify = store.get("render.classify");
        if (isObject(classify) && Array.isArray(classify.classes))
          next = setIn(next, "render.classify.classes", equalClasses(domain, classify.classes.length));
        return next;
      });
    }
  };

  const drawAs = async (next: RasterRenderType) => {
    let start = defaultRender(next, { info });
    if (next === "continuous" && !start.domain) {
      // A color range starts from the band's values: without any, the drawing stays as it is.
      const found = await sample(1);
      const domain = found && info ? seedDomain(found, info) : null;
      if (!domain) {
        setNote(t("style_editor.range_nothing_found"));
        return;
      }
      start = { ...start, domain };
    }
    setNote(null);
    store.update((doc) => {
      let out = setIn(doc, "render", start);
      if (next !== "image") for (const key of ADJUSTMENTS) out = setIn(out, key, undefined);
      return out;
    }, "render.type");
    if (next === "categorical" && !info?.colorTable) void seedFromData(1, next);
  };

  const label = t("style_editor.draw_as");
  const bandCount = info?.bands ?? 1;
  const bands = Array.isArray(bandsValue) ? bandsValue : TRUE_COLOR;
  // Custom stays picked while its bands equal true or false color: the default stays out of the document.
  const combination =
    custom || !(same(bands, TRUE_COLOR) || same(bands, FALSE_COLOR))
      ? "custom"
      : same(bands, TRUE_COLOR)
        ? "true"
        : "false";
  const bandOptions = Array.from({ length: bandCount }, (_, i) => ({
    value: i + 1,
    label: t("style_editor.band_n", { n: i + 1 }),
  }));
  return (
    <PanelSection title={t("style_editor.section_general")}>
      <ChoiceRow<RasterRenderType>
        label={label}
        value={type}
        fixed={options.length === 1}
        note={
          note ??
          (raster?.error === "refused"
            ? t("style_editor.raster_refused")
            : raster?.error
              ? t("style_editor.raster_unavailable")
              : undefined)
        }
        options={options.map((v) => ({
          value: v,
          label: t(`style_editor.raster_type_${v}`),
          sub: t(`style_editor.raster_type_${v}_sub`),
          icon: drawAsIcon(v),
        }))}
        onChange={(next) => void drawAs(next)}
      />
      {bandCount > 1 && (type === "continuous" || type === "categorical") && (
        <ChoiceRow<number>
          label={t("style_editor.band")}
          value={band}
          options={bandOptions}
          onChange={(next) => {
            store.set("render.band", next === 1 ? undefined : next);
            if (type === "continuous") void seedFromData(next, type);
          }}
        />
      )}
      {type === "image" && bandCount >= 3 && (
        <>
          <ChoiceRow<string>
            label={t("style_editor.bands")}
            value={combination}
            options={[
              { value: "true", label: t("style_editor.bands_true"), sub: t("style_editor.bands_true_sub") },
              ...(bandCount >= 4
                ? [
                    {
                      value: "false",
                      label: t("style_editor.bands_false"),
                      sub: t("style_editor.bands_false_sub"),
                    },
                  ]
                : []),
              {
                value: "custom",
                label: t("style_editor.bands_custom"),
                sub: t("style_editor.bands_custom_sub"),
              },
            ]}
            onChange={(next) => {
              setCustom(next === "custom");
              if (next !== "custom") store.set("render.bands", next === "true" ? undefined : FALSE_COLOR);
            }}
          />
          {combination === "custom" &&
            (["red", "green", "blue"] as const).map((channel, i) => (
              <ChoiceRow<number>
                key={channel}
                label={t(`style_editor.band_${channel}`)}
                value={typeof bands[i] === "number" ? (bands[i] as number) : i + 1}
                options={bandOptions}
                onChange={(next) => {
                  const picked = [...bands] as number[];
                  picked[i] = next;
                  store.set("render.bands", same(picked, TRUE_COLOR) ? undefined : picked);
                }}
              />
            ))}
        </>
      )}
    </PanelSection>
  );
}
