"use client";

// A raster's classes on the class grid of a classification (prototype 4.5, spec 9.4, 9.5): per class its color, the
// lower bound of manual breaks, its name with the range as placeholder (a category's name or code, which opens its
// editor), its share of the band's cells (a class's from the file's histogram, a category's from its cell count), and
// show or hide. A raster class has no style of its own, so the grid has no column for it.
import { ButtonBase, InputBase, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { useLoadedRasterValues } from "@/lib/api/rasters";
import { setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { coverageUrl } from "@/lib/style/layerSource";
import { rangeText, valuesText } from "@/lib/style/legend";
import { paletteColors } from "@/lib/style/palettes";
import { classColors, classEnds } from "@/lib/style/raster/color";
import {
  type HistogramBin,
  type RasterInfo,
  bandHistogram,
  bandLabel,
  codeShare,
  rangeShare,
} from "@/lib/style/raster/metadata";
import { valueQuery, valuesUrl } from "@/lib/style/raster/values";

import {
  useEditor,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import {
  CATEGORY_GRAY,
  ClassGrid,
  ClassGridRow,
} from "@/components/map/panels/styleEditor/editors/ClassGrid";
import {
  type RangeOptions,
  columnChars,
  rangeAfterBound,
  rangeWords,
} from "@/components/map/panels/styleEditor/editors/ClassList";
import { ColorRow, PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { NumberInput, Row, TextRow } from "@/components/map/panels/styleEditor/rows";

const classesOf = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isObject) : []);

/** A palette as a CSS gradient (continuous) or in steps (classes). */
export function paletteStrip(colors: string[], stepped: boolean): string | undefined {
  if (!colors.length) return undefined;
  if (!stepped) return `linear-gradient(90deg, ${colors.join(", ")})`;
  const n = colors.length;
  return `linear-gradient(90deg, ${colors.map((c, i) => `${c} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(", ")})`;
}

/** The colors a render shows, in order: its stops, its classes (as the map draws them, `classColors`) or its
 * palette. */
export function renderColors(render: JsonObject): { colors: string[]; stepped: boolean } {
  if (Array.isArray(render.stops))
    return {
      colors: render.stops.filter(isObject).map((s) => String(s.color)),
      stepped: render.interpolate === "nearest",
    };
  const palette = (render.palette ?? DEFAULTS["continuous.palette"]) as string | string[];
  const classify = isObject(render.classify) ? render.classify : null;
  if (classify && Array.isArray(classify.classes))
    return { colors: classColors(classify, palette, render.reverse), stepped: true };
  const colors = paletteColors(palette);
  return { colors: render.reverse === true ? [...colors].reverse() : colors, stepped: false };
}

/** A share of the band's cells as a percent in the panel's language ("12%", "0.4%"); nothing when unknown. */
export function shareText(share: number | undefined, locale: string): string | undefined {
  if (share === undefined) return undefined;
  const digits = share > 0 && share < 0.1 ? 1 : 0;
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits });
  // A code or class with a few cells is in use: it does not read as 0 %.
  return share > 0 && share < 0.001 ? `< ${percent.format(0.001)}` : percent.format(share);
}

/** A category's code as its row and the legend write it: the number, with the legend's unit. */
export function useCodeLabel(): (value: unknown) => string {
  const { i18n } = useTranslation("common");
  const unit = useStyleValue<unknown>("legend.unit");
  return (value) =>
    typeof value === "number"
      ? valuesText([value], {
          locale: i18n.language,
          unit: typeof unit === "string" && unit ? unit : undefined,
        })
      : "";
}

/** The band a render colors, when it is one of the file's bands (a formula has no statistics of its own). */
export const renderBand = (render: JsonObject): number | undefined => {
  const band = render.band ?? 1;
  return typeof band === "number" ? band : undefined;
};

/** The band's histogram, none for a formula. */
export const renderHistogram = (render: JsonObject, info: RasterInfo | undefined): HistogramBin[] => {
  const band = renderBand(render);
  return band === undefined ? [] : bandHistogram(info, band);
};

/** The name of what the classes cover: the band as the file names it, or the formula. */
function inputLabel(render: JsonObject, info: RasterInfo | undefined, t: TFunction): string {
  const band = render.band;
  if (isObject(band))
    return typeof band.name === "string" && band.name ? band.name : String(band.expression ?? "");
  return bandLabel(info, renderBand(render) ?? 1, t);
}

/** The editor of category `index` (its name, cell value and color), opened from its row or when it is added. */
export function CategoryEditor({ index }: { index: number }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const codeLabel = useCodeLabel();
  const record = useStyleValue<unknown>(`render.classes.${index}`);
  if (!isObject(record)) return null;
  const path = `render.classes.${index}`;
  return (
    <>
      <TextRow
        label={t("style_editor.category_name")}
        value={typeof record.name === "string" ? record.name : ""}
        placeholder={codeLabel(record.value)}
        onChange={(v) => store.set(`${path}.name`, v || undefined)}
      />
      <Row label={t("style_editor.cell_value")}>
        <NumberInput
          value={record.value as number}
          ariaLabel={t("style_editor.cell_value")}
          onChange={(v) => store.set(`${path}.value`, Math.round(v))}
        />
      </Row>
      <ColorRow label={t("style_editor.color")} path={`${path}.color`} fallback={CATEGORY_GRAY} />
    </>
  );
}

/** Opens category `index`'s editor one level deeper, with "Remove class". */
export function useCategoryOpener(): (index: number, title: string, anchorTop: number) => void {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const next = useNextLevel();
  return (index, title, anchorTop) =>
    popover.open(next, {
      key: `category:${index}`,
      title,
      anchorTop,
      render: () => <CategoryEditor index={index} />,
      onDelete: {
        label: t("style_editor.remove_class"),
        onClick: () => {
          store.set(
            "render.classes",
            classesOf(store.get("render.classes")).filter((_, j) => j !== index)
          );
          popover.close(next);
        },
      },
    });
}

/** A class's color: a swatch that opens the color picker for `path`. */
function Swatch({ path, color, title }: { path: string; color: string; title: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  return (
    <ButtonBase
      aria-label={t("style_editor.class_color")}
      onClick={(event) =>
        popover.open("picker", {
          key: `raster-class-color:${path}`,
          title,
          anchorTop: anchorTopOf(event.currentTarget),
          anchorEl: event.currentTarget,
          render: () => (
            <PathColorPicker path={path} fallback={color} write={(hex) => store.set(path, hex)} />
          ),
        })
      }
      sx={{
        width: 20,
        height: 20,
        flex: "none",
        borderRadius: 0.5,
        border: 1,
        borderColor: "divider",
        background: color,
      }}
    />
  );
}

function ClassRows({
  render,
  bins,
  options,
}: {
  render: JsonObject;
  bins: HistogramBin[];
  options: RangeOptions;
}) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const classify = isObject(render.classify) ? render.classify : {};
  const classes = classesOf(classify.classes);
  const manual = classify.method === "manual";
  const { colors } = renderColors(render);
  // The bounds as their boxes show them (two decimals at most), one column wide enough for the longest.
  const reserve = columnChars(classes.slice(1).map((c) => c.from));
  return (
    <>
      {classes.map((c, i) => {
        const path = `render.classify.classes.${i}`;
        const from = typeof c.from === "number" ? c.from : undefined;
        const to = typeof c.to === "number" ? c.to : undefined;
        const range = rangeText({ from, to }, options);
        const name = typeof c.name === "string" ? c.name : "";
        const hidden = c.visible === false;
        return (
          <ClassGridRow
            key={typeof c.id === "string" ? c.id : i}
            hidden={hidden}
            onToggle={() => store.set(`${path}.visible`, hidden ? undefined : false)}
            swatch={<Swatch path={`${path}.color`} color={colors[i]} title={name || range} />}
            bound={
              manual && i > 0 ? (
                <NumberInput
                  value={from}
                  plain
                  reserve={reserve}
                  ariaLabel={t("style_editor.lower_bound")}
                  onChange={(v) =>
                    store.update(
                      (doc) => setIn(setIn(doc, `${path}.from`, v), `render.classify.classes.${i - 1}.to`, v),
                      `${path}.from`
                    )
                  }
                />
              ) : undefined
            }
            label={
              <InputBase
                value={name}
                placeholder={manual && i > 0 ? rangeAfterBound(c, options, t) : range}
                inputProps={{ "aria-label": t("style_editor.class_name") }}
                onChange={(event) => store.set(`${path}.name`, event.target.value || undefined)}
                sx={{ minWidth: 0, typography: "body2", "& input": { p: 0 } }}
              />
            }
            count={shareText(rangeShare(bins, from, to), i18n.language)}
          />
        );
      })}
    </>
  );
}

function CategoryRows({ render, options }: { render: JsonObject; options: RangeOptions }) {
  const { i18n } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const openCategory = useCategoryOpener();
  const band = renderBand(render);
  return (
    <>
      {classesOf(render.classes).map((c, i) => {
        const path = `render.classes.${i}`;
        const value = typeof c.value === "number" ? c.value : undefined;
        const name = typeof c.name === "string" ? c.name : "";
        const label = name || (value !== undefined ? valuesText([value], options) : "");
        const hidden = c.visible === false;
        return (
          <ClassGridRow
            key={i}
            hidden={hidden}
            onToggle={() => store.set(`${path}.visible`, hidden ? undefined : false)}
            swatch={
              <Swatch
                path={`${path}.color`}
                color={typeof c.color === "string" ? c.color : CATEGORY_GRAY}
                title={label}
              />
            }
            label={
              <ButtonBase
                aria-haspopup="dialog"
                title={label}
                onClick={(event) => openCategory(i, label, anchorTopOf(event.currentTarget))}
                sx={{
                  minWidth: 0,
                  height: 28,
                  mx: -1,
                  px: 1,
                  borderRadius: 1,
                  justifyContent: "flex-start",
                  "&:hover": { bgcolor: "action.hover" },
                }}>
                <Typography variant="body2" noWrap>
                  {label}
                </Typography>
              </ButtonBase>
            }
            count={
              value !== undefined && band !== undefined
                ? shareText(codeShare(raster?.info, band, value), i18n.language)
                : undefined
            }
          />
        );
      })}
    </>
  );
}

/** The classes of a raster color range (`render.classify`) or its categories (`render.classes`). */
export function RasterClassList({ kind }: { kind: "classes" | "categories" }) {
  const { t, i18n } = useTranslation("common");
  const { raster } = useStyleData();
  const value = useStyleValue<unknown>("render");
  const unit = useStyleValue<unknown>("legend.unit");
  const render: JsonObject = isObject(value) ? value : {};
  const info = raster?.info;
  const bins = renderHistogram(render, info);
  // Open ends read the band's minimum and maximum (a formula's from the values the map loaded), as the legend and the
  // popup write them (`classEnds`).
  const address = useStyleSelector((doc) => {
    const query = raster ? valueQuery(doc as unknown as JsonObject) : null;
    return raster && query ? valuesUrl(coverageUrl(raster.dataset), query) : undefined;
  });
  const described = useLoadedRasterValues(address);
  const domain = classEnds(render, { info, range: described?.range });
  const options: RangeOptions = {
    locale: i18n.language,
    words: rangeWords(t),
    unit: typeof unit === "string" && unit ? unit : undefined,
    domain,
  };
  const classify = isObject(render.classify) ? render.classify : {};
  return (
    <ClassGrid
      head={{
        value: t("style_editor.color"),
        label: inputLabel(render, info, t),
        count: t("style_editor.share"),
      }}
      bounds={kind === "classes" && classify.method === "manual"}
      styled={false}>
      {kind === "classes" ? (
        <ClassRows render={render} bins={bins} options={options} />
      ) : (
        <CategoryRows render={render} options={options} />
      )}
    </ClassGrid>
  );
}
