"use client";

// A raster's classes on the class grid of a classification (prototype 4.5, spec 9.4, 9.5): per class its color, the
// lower bound of manual breaks, its name with the range as placeholder (a category's name or code, which opens its
// editor), its share of the band's cells (a class's from the file's histogram, a category's from its cell count), and
// show or hide. A raster class has no style of its own, so the grid has no column for it.
import { ButtonBase, InputBase, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useLoadedRasterValues } from "@/lib/api/rasters";
import { OTHER_COLOR, moveItem } from "@/lib/style/editor/raster";
import { getIn, setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { coverageUrl } from "@/lib/style/layerSource";
import { rangeText, valuesText } from "@/lib/style/legend";
import { paletteColors } from "@/lib/style/palettes";
import { classColors, classEnds, classReach } from "@/lib/style/raster/color";
import { bandOrFormula } from "@/lib/style/raster/formula";
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
  ClassGridMore,
  ClassGridRow,
  FOCUS_MARK,
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
  useCloseWhenGone,
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

/** The histogram of the band, or of the band formula where the info was asked for it; none where it is not known. */
export const renderHistogram = (render: JsonObject, info: RasterInfo | undefined): HistogramBin[] =>
  bandHistogram(info, bandOrFormula(render.band));

/** The name of what the classes cover: the band as the file names it, or the formula. */
function inputLabel(render: JsonObject, info: RasterInfo | undefined, t: TFunction): string {
  const band = render.band;
  if (isObject(band))
    return typeof band.name === "string" && band.name ? band.name : String(band.expression ?? "");
  return bandLabel(info, renderBand(render) ?? 1, t);
}

/** The category an open editor edits: its code, and its place in the list when last seen. */
interface CategoryBinding {
  code: unknown;
  index: number;
}

/** Where the bound category is in `classes` now: at the place it was last seen while that class still has its code (a
 * code typed there that another class also has stays with the class it was typed into), else at the first class with
 * its code; -1 where no class has it. */
function placeOf(classes: JsonObject[], bound: CategoryBinding): number {
  if (classes[bound.index]?.value === bound.code) return bound.index;
  return classes.findIndex((c) => c.value === bound.code);
}

/** The editor of one category (its name, cell value and color), opened from its row or when it is added. It goes on
 * with that category when the list is put in another order or a class before it goes, and closes when no class has
 * its code any more. */
export function CategoryEditor({ bound }: { bound: CategoryBinding }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const codeLabel = useCodeLabel();
  const classes = classesOf(useStyleValue<unknown>("render.classes"));
  const index = placeOf(classes, bound);
  if (index >= 0) bound.index = index;
  useCloseWhenGone(index < 0);
  const record = classes[index];
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
          onChange={(v) => {
            bound.code = Math.round(v);
            store.set(`${path}.value`, bound.code);
          }}
        />
      </Row>
      {/* Its picker writes to the class at this place: drawn anew at another place, the open picker closes. */}
      <ColorRow key={index} label={t("style_editor.color")} path={`${path}.color`} fallback={CATEGORY_GRAY} />
    </>
  );
}

/** Opens the editor of the category at `index` one level deeper, with "Remove class". */
export function useCategoryOpener(): (index: number, title: string, anchorTop: number) => void {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const next = useNextLevel();
  return (index, title, anchorTop) => {
    const bound: CategoryBinding = { code: classesOf(store.get("render.classes"))[index]?.value, index };
    popover.open(next, {
      key: `category:${String(bound.code)}`,
      title,
      anchorTop,
      render: () => <CategoryEditor bound={bound} />,
      onDelete: {
        label: t("style_editor.remove_class"),
        onClick: () => {
          const classes = classesOf(store.get("render.classes"));
          const at = placeOf(classes, bound);
          if (at >= 0)
            store.set(
              "render.classes",
              classes.filter((_, j) => j !== at)
            );
          popover.close(next);
        },
      },
    });
  };
}

/** A class's color: a swatch that opens the color picker for `path`. */
function Swatch({
  path,
  color,
  title,
  ariaLabel,
}: {
  path: string;
  color: string;
  title: string;
  /** Its name, translated by the list once for all rows. */
  ariaLabel: string;
}) {
  const store = useEditor();
  const popover = usePopover();
  return (
    <ButtonBase
      disableRipple
      aria-label={ariaLabel}
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
        ...FOCUS_MARK,
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
  // Each class's values as the map draws them (`classReach`): with the end colors outside, the first and last class
  // hold every cell beyond, whatever ends they carry; with values outside left out, they end at their own ends, else at
  // the range (`options.domain`, `classEnds`).
  const reach = classReach(
    {
      classes: classes.map((c) => ({
        ...(typeof c.from === "number" ? { from: c.from } : {}),
        ...(typeof c.to === "number" ? { to: c.to } : {}),
      })),
      domain: null,
      outside: render.outside === "hide" ? "hide" : "clamp",
    },
    options.domain
  );
  // The bounds as their boxes show them (two decimals at most), one column wide enough for the longest.
  const reserve = columnChars(classes.slice(1).map((c) => c.from));
  return (
    <>
      {classes.map((c, i) => {
        const path = `render.classify.classes.${i}`;
        const { from, to } = reach[i];
        const range = rangeText({ from, to }, options);
        const share = shareText(rangeShare(bins, from, to), i18n.language);
        const name = typeof c.name === "string" ? c.name : "";
        const hidden = c.visible === false;
        return (
          <ClassGridRow
            key={typeof c.id === "string" ? c.id : i}
            hidden={hidden}
            onToggle={() => store.set(`${path}.visible`, hidden ? undefined : false)}
            swatch={
              <Swatch
                path={`${path}.color`}
                color={colors[i]}
                title={name || range}
                ariaLabel={t("style_editor.class_color")}
              />
            }
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
                placeholder={manual && i > 0 ? rangeAfterBound({ from, to }, options, t) : range}
                inputProps={{ "aria-label": t("style_editor.class_name") }}
                onChange={(event) => store.set(`${path}.name`, event.target.value || undefined)}
                sx={{ minWidth: 0, typography: "body2", "& input": { p: 0 } }}
              />
            }
            count={share}
          />
        );
      })}
    </>
  );
}

/** A long list of categories shows this many rows, then "Show N more". */
const CATEGORY_ROWS = 10;
/** "Show N more" adds this many rows at once, then as many again each frame, so the first appear at once. */
const ROWS_PER_FRAME = 50;

/** One category's row, from what it shows only: an edit of another class leaves it as it is (a long list draws only
 * the row it changes). */
const CategoryRow = memo(function CategoryRow({
  index,
  label,
  color,
  hidden,
  share,
  colorLabel,
  onOpen,
}: {
  index: number;
  label: string;
  color: string;
  hidden: boolean;
  share?: string;
  /** The swatch's name (translated once by the list). */
  colorLabel: string;
  /** Opens the category's editor: the same function for every row and every draw. */
  onOpen: (index: number, title: string, anchorTop: number) => void;
}) {
  const store = useEditor();
  const path = `render.classes.${index}`;
  return (
    <ClassGridRow
      index={index}
      hidden={hidden}
      onToggle={() => store.set(`${path}.visible`, hidden ? undefined : false)}
      swatch={<Swatch path={`${path}.color`} color={color} title={label} ariaLabel={colorLabel} />}
      label={
        <ButtonBase
          disableRipple
          aria-haspopup="dialog"
          title={label}
          onClick={(event) => onOpen(index, label, anchorTopOf(event.currentTarget))}
          sx={{
            minWidth: 0,
            height: 28,
            mx: -1,
            px: 1,
            borderRadius: 1,
            justifyContent: "flex-start",
            "&:hover": { bgcolor: "action.hover" },
            ...FOCUS_MARK,
          }}>
          <Typography variant="body2" noWrap>
            {label}
          </Typography>
        </ButtonBase>
      }
      count={share}
    />
  );
});

function CategoryRows({ render, options }: { render: JsonObject; options: RangeOptions }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  // How many rows show: the first ten, or after "Show N more" more each frame until all show.
  const [limit, setLimit] = useState(CATEGORY_ROWS);
  // One opener for every row, the same across draws (it opens the editor of the class at that index now).
  const openCategory = useCategoryOpener();
  const opener = useRef(openCategory);
  useEffect(() => {
    opener.current = openCategory;
  });
  const onOpen = useCallback(
    (index: number, title: string, anchorTop: number) => opener.current(index, title, anchorTop),
    []
  );
  const colorLabel = t("style_editor.class_color");
  const band = renderBand(render);
  const info = raster?.info;
  const classes = classesOf(render.classes);
  // A class added at the end ("Add class") would land behind "Show N more": the list opens so that it shows.
  const [counted, setCounted] = useState(classes.length);
  if (classes.length !== counted) {
    setCounted(classes.length);
    if (classes.length === counted + 1 && classes.length > CATEGORY_ROWS && limit <= CATEGORY_ROWS)
      setLimit(CATEGORY_ROWS + ROWS_PER_FRAME);
  }
  const expanded = limit > CATEGORY_ROWS;
  const shown = classes.slice(0, expanded ? limit : CATEGORY_ROWS);
  useEffect(() => {
    if (!expanded || limit >= classes.length) return;
    const frame = requestAnimationFrame(() => setLimit((n) => n + ROWS_PER_FRAME));
    return () => cancelAnimationFrame(frame);
  }, [expanded, limit, classes.length]);
  const share = (value: number) => (band !== undefined ? codeShare(info, band, value) : undefined);
  // The values without a class: the band's codes no class lists, drawn in the other values' color when one is set.
  const listed = new Set(classes.map((c) => c.value));
  const codes = band !== undefined ? (info?.stats.find((b) => b.index === band)?.values ?? null) : null;
  const left = codes?.filter((v) => !listed.has(v)) ?? null;
  const shares = left?.map(share);
  const otherShare =
    shares && shares.every((v) => v !== undefined)
      ? shares.reduce<number>((sum, v) => sum + (v ?? 0), 0)
      : undefined;
  const otherColor = typeof render.other_color === "string" ? render.other_color : undefined;
  return (
    <>
      {shown.map((c, i) => {
        const value = typeof c.value === "number" ? c.value : undefined;
        const name = typeof c.name === "string" ? c.name : "";
        return (
          <CategoryRow
            key={`${value ?? "x"}-${i}`}
            index={i}
            label={name || (value !== undefined ? valuesText([value], options) : "")}
            color={typeof c.color === "string" ? c.color : CATEGORY_GRAY}
            hidden={c.visible === false}
            share={value !== undefined ? shareText(share(value), i18n.language) : undefined}
            colorLabel={colorLabel}
            onOpen={onOpen}
          />
        );
      })}
      {!expanded && shown.length < classes.length && (
        <ClassGridMore
          hidden={classes.length - shown.length}
          onShow={() => setLimit(CATEGORY_ROWS + ROWS_PER_FRAME)}
        />
      )}
      {/* Other values: drawn in their color, or left out with the eye; standing back where every code has a class. */}
      <ClassGridRow
        hidden={!otherColor}
        absent={left?.length === 0}
        onToggle={() => store.set("render.other_color", otherColor ? undefined : OTHER_COLOR)}
        swatch={
          <Swatch
            path="render.other_color"
            color={otherColor ?? OTHER_COLOR}
            title={t("style_editor.other_values")}
            ariaLabel={colorLabel}
          />
        }
        label={
          <Typography variant="body2" noWrap>
            {t("style_editor.other_values")}
          </Typography>
        }
        count={shareText(otherShare, i18n.language)}
      />
    </>
  );
}

/** The classes of a raster color range (`render.classify`) or its categories (`render.classes`). */
export function RasterClassList({ kind }: { kind: "classes" | "categories" }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const value = useStyleValue<unknown>("render");
  const unit = useStyleValue<unknown>("legend.unit");
  const render: JsonObject = isObject(value) ? value : {};
  const info = raster?.info;
  const bins = renderHistogram(render, info);
  // Open ends read the band's minimum and maximum (a formula's from the values the map loaded), or with values outside
  // left out where the drawing stops, as the legend and the popup write them (`classEnds`).
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
      styled={false}
      rows={Array.isArray(render.classes) ? render.classes.length : 0}
      // Categories are listed in the order the legend shows them: drag one to another's place to move it.
      onReorder={
        kind === "categories"
          ? (from, to) =>
              store.update((doc) => {
                const now = getIn(doc, "render.classes");
                return Array.isArray(now) ? setIn(doc, "render.classes", moveItem(now, from, to)) : doc;
              }, "render.classes")
          : undefined
      }>
      {kind === "classes" ? (
        <ClassRows render={render} bins={bins} options={options} />
      ) : (
        <CategoryRows render={render} options={options} />
      )}
    </ClassGrid>
  );
}
