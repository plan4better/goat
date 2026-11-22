"use client";

// General for raster files (prototype 3.1, 3.2; spec 9): how the cells are drawn, which band or band formula (also the
// one a hillshade shades; `RasterBandRows`), and which bands make the picture. Switching to a color range starts from the band's values (the raster service's statistics) or the
// file's type, so the choice waits for the file's info; a file the service cannot read says so once, at the top.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { type RasterRenderType, defaultRender, drawAsOptions } from "@/lib/style/editor/raster";
import { setIn } from "@/lib/style/editor/store";
import { bandLabel, drawingFacts, imageBands, seedDomain, valueBands } from "@/lib/style/raster/metadata";
import type { StyleIssue } from "@/lib/style/save";

import { IssueNotice } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useEditor,
  useRasterSample,
  useRasterWaiting,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { drawAsIcon } from "@/components/map/panels/styleEditor/drawAsIcons";
import { RasterBandRows } from "@/components/map/panels/styleEditor/editors/RasterBandRows";
import {
  dropOffer,
  offerMove,
  placementKey,
  useLayerMapState,
} from "@/components/map/panels/styleEditor/mapState";
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
  const mapState = useLayerMapState();
  const sample = useRasterSample();
  const waiting = useRasterWaiting();
  // Each key on its own: `render` also holds the classes, which this section does not show.
  const typeValue = useStyleValue<unknown>("render.type");
  const bandsValue = useStyleValue<unknown>("render.bands");
  const [custom, setCustom] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const type = (typeof typeValue === "string" ? typeValue : "image") as RasterRenderType;
  const info = raster?.info;
  const options = drawAsOptions(info);
  if (!options.includes(type)) options.push(type);

  const drawAs = async (next: RasterRenderType) => {
    // The layer and its place as the choice is made: the values of a color range may take a request.
    const onTop = mapState?.position === "top";
    const key = mapState ? placementKey(mapState, store) : undefined;
    // Categories start with the band's codes, in the file's colors where it has a table.
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
    if (key === undefined) return;
    // Colors of its own in place of an image, on top of the basemap: they hide its place names, so the Position row
    // offers the move below them (spec 10). The layer stays where it is.
    if (type === "image" && next !== "image" && onTop) offerMove(key, store);
    else if (next === "image") dropOffer(key);
  };

  const label = t("style_editor.draw_as");
  const failure: StyleIssue | null = raster?.error
    ? {
        level: raster.error === "refused" ? "error" : "warning",
        code: `raster_${raster.error}`,
        path: "render",
        message: t(
          raster.error === "refused" ? "style_editor.raster_refused" : "style_editor.raster_unavailable"
        ),
      }
    : null;
  // The bands of values: an alpha band (an orthophoto's transparency) is none, though the file counts it.
  const ownBands = info ? valueBands(info) : [1];
  const bandCount = ownBands.length;
  // True color: the bands an image draws without chosen ones (`imageBands`), those its file marks red, green and blue,
  // else its first three.
  const drawn = imageBands(undefined, drawingFacts(info));
  const trueColor = drawn?.length === 3 ? drawn : TRUE_COLOR;
  const bands = Array.isArray(bandsValue) ? bandsValue : trueColor;
  // Custom stays picked while its bands equal true or false color: the default stays out of the document.
  const combination =
    custom || !(same(bands, trueColor) || same(bands, FALSE_COLOR))
      ? "custom"
      : same(bands, trueColor)
        ? "true"
        : "false";
  const bandOptions = ownBands.map((index) => ({ value: index, label: bandLabel(info, index, t) }));
  return (
    <PanelSection
      title={t("style_editor.section_general")}
      scopeNote={failure && <IssueNotice issue={failure} />}>
      <ChoiceRow<RasterRenderType>
        label={label}
        value={type}
        fixed={!waiting && options.length === 1}
        disabled={waiting}
        note={note ?? undefined}
        options={options.map((v) => ({
          value: v,
          label: t(`style_editor.raster_type_${v}`),
          sub: t(`style_editor.raster_type_${v}_sub`),
          icon: drawAsIcon(v),
        }))}
        onChange={(next) => void drawAs(next)}
      />
      {type !== "image" && <RasterBandRows type={type} />}
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
                  store.set("render.bands", same(picked, trueColor) ? undefined : picked);
                }}
              />
            ))}
        </>
      )}
    </PanelSection>
  );
}
