"use client";

// The colors of a raster color range or hillshade (prototype 4.7; spec 9.2, 9.4): a palette over a written range,
// continuous or in classes (equal intervals, quantiles, natural breaks, standard deviation, geometric intervals, or
// breaks typed by hand) on the class grid of a classification, over the band's histogram; or own colors at own values.
// The computed breaks come with the file's info from the raster service, so a method or count writes its classes at
// once. What cells beyond the colors draw (Outside) applies to classes too: with values outside left out, the classes'
// outer ends are a range to type. The range's ends and the class breaks stand on the histogram as handles to drag. A
// continuous palette's colors are a list to edit at the bottom (`PaletteColors`); classes are edited in their rows.
import { Box, Button } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { withStored } from "@/lib/style/editor/defaults";
import { paletteList } from "@/lib/style/editor/paletteList";
import {
  BREAK_METHODS,
  RANGED_METHODS,
  breakCounts,
  equalClasses,
  geometricRefused,
  rasterClassesRender,
  setBreak,
  setOuterEnd,
  setRasterPalette,
  wholeBand,
} from "@/lib/style/editor/raster";
import { getIn, setIn } from "@/lib/style/editor/store";
import { plainNumber } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";
import { paletteColors, paletteSteps } from "@/lib/style/palettes";
import { classEnds } from "@/lib/style/raster/color";
import { bandOrFormula, formulaOf } from "@/lib/style/raster/formula";
import { bandRange, seedDomain } from "@/lib/style/raster/metadata";

import { IssueNotice, useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useEditor,
  useRasterSample,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { paletteLabel } from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { Histogram, type HistogramHandle } from "@/components/map/panels/styleEditor/editors/Histogram";
import { PaletteColors, type PaletteSource } from "@/components/map/panels/styleEditor/editors/PaletteColors";
import {
  RasterClassList,
  paletteStrip,
  renderColors,
  renderHistogram,
} from "@/components/map/panels/styleEditor/editors/RasterClassList";
import { StopsEditor } from "@/components/map/panels/styleEditor/editors/StopsEditor";
import { PalettePicker } from "@/components/map/panels/styleEditor/pickers/PalettePicker";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, NumberInput, Row, SwitchRow } from "@/components/map/panels/styleEditor/rows";

/** The ways a palette colors a range: blended, or in classes by a method. */
const METHODS = [
  "continuous",
  "equal_interval",
  "quantile",
  "natural_breaks",
  "std_dev",
  "geometric_interval",
  "manual",
];
const CLASS_COUNT = 5;
/** A histogram bar of values the map leaves out (beyond the classes or the range, with Outside Transparent). */
const LEFT_OUT = "rgba(154, 163, 173, 0.35)";

/** A method's line in the menu: the raster's words where a cell is not a feature, else the vectors'. */
const methodSub = (method: string) =>
  ["continuous", "manual", "quantile"].includes(method)
    ? `style_editor.raster_method_${method}_sub`
    : `style_editor.method_${method}_sub`;

/** The range the colors cover: the written one, else the computed one, else the band's minimum and maximum. */
function rangeOf(render: JsonObject, info: Parameters<typeof bandRange>[0]): [number, number] {
  const given = Array.isArray(render.domain) ? render.domain : null;
  const computed =
    isObject(render.computed) && Array.isArray(render.computed.domain) ? render.computed.domain : null;
  return (
    ((given ?? computed) as [number, number] | null) ?? bandRange(info, bandOrFormula(render.band)) ?? [0, 1]
  );
}

export function RasterColorsEditor() {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const sample = useRasterSample();
  const { raster } = useStyleData();
  const value = useStyleValue<unknown>("render");
  const [note, setNote] = useState<string | null>(null);
  const render: JsonObject = isObject(value) ? value : {};
  const info = raster?.info;
  const hillshade = render.type === "hillshade";
  const band = typeof render.band === "number" ? render.band : 1;
  // What From the data and the shading's colors start from: the band's values, or a band formula's.
  const sampled = formulaOf(render.band)?.expression ?? band;
  const stops = Array.isArray(render.stops) ? render.stops.filter(isObject) : null;
  const domain = rangeOf(render, info);
  const classify = isObject(render.classify) ? render.classify : null;
  const classes = classify && Array.isArray(classify.classes) ? classify.classes : [];
  const method = classify ? (typeof classify.method === "string" ? classify.method : "manual") : "continuous";
  const manual = method === "manual";
  const count = manual
    ? classes.length || CLASS_COUNT
    : typeof classify?.count === "number"
      ? classify.count
      : classes.length || CLASS_COUNT;
  const colored = !hillshade || render.palette !== undefined;
  // Only a continuous palette, equal intervals and manual breaks take a range; every other method classifies the
  // band's values themselves. With values outside left out, classes end at their outer ends (`classEnds`, the rule
  // the map draws by): those are the range, typed as a whole. Equal intervals keep splitting their range instead.
  const ranged = RANGED_METHODS.includes(method);
  const hide = render.outside === "hide";
  const classed = classes.filter(isObject);
  const outer: [number, number] | null =
    classify && hide && classes.length && method !== "equal_interval"
      ? (classEnds(render, { info }) ?? domain)
      : null;
  const setEnd = (end: "from" | "to", v: number) =>
    store.update((doc) => {
      const now = getIn(doc, "render");
      return setIn(doc, "render", setOuterEnd(isObject(now) ? now : render, end, v));
    }, "render.classify");
  const shown = outer ?? domain;

  /** The render with `range` written; equal intervals split it again, and from the data manual classes too. */
  const withRange = (doc: LayerStyle, range: [number, number], fromData = false): LayerStyle => {
    const now = getIn(doc, "render");
    const next: JsonObject = { ...(isObject(now) ? now : render), domain: range };
    const c = isObject(next.classify) ? next.classify : null;
    if (c?.method === "equal_interval")
      return setIn(doc, "render", rasterClassesRender(next, "equal_interval", count, info));
    if (c && fromData)
      return setIn(setIn(doc, "render", next), "render.classify.classes", equalClasses(range, count));
    return setIn(doc, "render", next);
  };

  const fromData = async () => {
    const found = await sample(band);
    const seeded = found && info ? seedDomain(found, info) : null;
    if (!seeded) {
      setNote(t("style_editor.range_nothing_found"));
      return;
    }
    setNote(null);
    store.update((doc) => withRange(doc, seeded, true), "render.domain");
  };

  /** Hillshade colors on start from a written range or the values on the map; with neither they stay off. */
  const toggleColors = async () => {
    if (colored) {
      store.update((doc) => {
        const next = { ...render };
        for (const key of ["palette", "reverse", "domain", "classify", "outside"]) delete next[key];
        return setIn(doc, "render", next);
      });
      return;
    }
    let range = Array.isArray(render.domain) ? (render.domain as [number, number]) : null;
    if (!range) {
      const found = await sample(band);
      range = found && info ? seedDomain(found, info) : null;
    }
    if (!range) {
      setNote(t("style_editor.range_nothing_found"));
      return;
    }
    setNote(null);
    const seeded = range;
    store.update((doc) => {
      const now = getIn(doc, "render");
      const base = isObject(now) ? now : render;
      return setIn(doc, "render", { ...base, palette: DEFAULTS["continuous.palette"], domain: seeded });
    });
  };

  const setKind = (kind: string) =>
    store.update((doc) => {
      if (kind === "stops") {
        const colors = paletteSteps(
          (render.palette ?? DEFAULTS["continuous.palette"]) as string | string[],
          5
        );
        const ordered = render.reverse === true ? [...colors].reverse() : colors;
        const [d0, d1] = domain;
        const next = {
          ...render,
          stops: ordered.map((color, i) => ({ value: d0 + ((d1 - d0) * i) / 4, color })),
        };
        for (const key of ["palette", "reverse", "domain", "classify"]) delete next[key];
        return setIn(doc, "render", next);
      }
      const values = (stops ?? []).map((s) => s.value as number);
      const next: JsonObject = { ...render, domain: [values[0] ?? 0, values[values.length - 1] ?? 1] };
      delete next.stops;
      delete next.interpolate;
      return setIn(doc, "render", next);
    }, "render.colors");

  /** The classes of `next` in `n` classes, written at once (the breaks are the file's info). */
  const classesBy = (next: string, n: number) =>
    store.update((doc) => {
      const now = getIn(doc, "render");
      return setIn(doc, "render", rasterClassesRender(isObject(now) ? now : render, next, n, info));
    }, "render.classify");

  const countsOf = (m: string) => breakCounts(info, render.band ?? 1, m);
  const setMethod = (next: string) => {
    // Manual breaks keep the classes there are; a computed method keeps the count where it has breaks for it.
    if (next === "manual") return classesBy(next, classes.length || count);
    const offered = countsOf(next);
    const n = offered.includes(count)
      ? count
      : offered.includes(CLASS_COUNT)
        ? CLASS_COUNT
        : (offered[0] ?? CLASS_COUNT);
    classesBy(next, n);
  };

  const openPalette = (anchor: HTMLElement) =>
    popover.open("picker", {
      key: "raster:palette",
      title: t("style_editor.palette"),
      anchorTop: anchorTopOf(anchor),
      anchorEl: anchor,
      render: () => <RasterPalettePicker steps={classify ? classes.length || count : undefined} />,
    });

  const { colors, stepped } = renderColors(render);
  const bins = renderHistogram(render, info);
  const breaks = classes
    .slice(1)
    .map((c) => (isObject(c) ? c.from : undefined))
    .filter((b): b is number => typeof b === "number");
  const ramp = paletteColors((render.palette ?? DEFAULTS["continuous.palette"]) as string | string[]);
  const ordered = render.reverse === true ? [...ramp].reverse() : ramp;
  // Each bar in the color its middle draws in: its class's, or the ramp's at its place in the range; a bar the map
  // leaves out (values outside left out) stands back.
  const colorAt = (v: number) => {
    const [lo, hi] = shown;
    if (hide && (v < Math.min(lo, hi) || v > Math.max(lo, hi))) return LEFT_OUT;
    if (classify) return colors[breaks.filter((b) => v >= b).length] ?? colors[colors.length - 1];
    const [d0, d1] = domain;
    const at = d1 === d0 ? 0 : Math.min(1, Math.max(0, (v - d0) / (d1 - d0)));
    return ordered[Math.round(at * (ordered.length - 1))] ?? "#9aa3ad";
  };
  // On the histogram: the range's ends, dragged as their boxes type them (with values outside left out, the classes'
  // outer ends, which stay outside the breaks), and the breaks, dragged as a bound typed in the grid (the classes
  // become manual and keep their other breaks). With values outside left out the first and last break stay inside the
  // ends the classes draw to (`shown`: their outer ends, or equal intervals' range).
  const cuts = classed.flatMap((c, k) => (k > 0 && typeof c.from === "number" ? [{ k, at: c.from }] : []));
  const handles: HistogramHandle[] = [];
  if (ranged || outer) {
    const [lo, hi] = shown;
    const firstCut = outer ? cuts[0]?.at : undefined;
    const lastCut = outer ? cuts[cuts.length - 1]?.at : undefined;
    handles.push(
      {
        id: "lo",
        value: lo,
        kind: "end",
        label: t("style_editor.range_lowest"),
        max: firstCut ?? hi,
        onChange: (v) =>
          outer ? setEnd("from", v) : store.update((doc) => withRange(doc, [v, domain[1]]), "render.domain"),
      },
      {
        id: "hi",
        value: hi,
        kind: "end",
        label: t("style_editor.range_highest"),
        min: lastCut ?? lo,
        onChange: (v) =>
          outer ? setEnd("to", v) : store.update((doc) => withRange(doc, [domain[0], v]), "render.domain"),
      }
    );
  }
  cuts.forEach(({ k, at }, j) =>
    handles.push({
      id: `break-${k}`,
      value: at,
      kind: "break",
      label: t("style_editor.class_break_n", { n: j + 1 }),
      min: cuts[j - 1]?.at ?? (hide ? shown[0] : undefined),
      max: cuts[j + 1]?.at ?? (hide ? shown[1] : undefined),
      onChange: (v) =>
        store.update((doc) => {
          const now = getIn(doc, "render");
          return setIn(doc, "render", setBreak(isObject(now) ? now : render, k, v, info));
        }, "render.classify"),
    })
  );
  return (
    <>
      {hillshade && (
        <SwitchRow
          label={t("style_editor.hillshade_colors")}
          on={colored}
          valueText={t(colored ? "style_editor.hillshade_colors_on" : "style_editor.hillshade_colors_off")}
          note={colored ? undefined : (note ?? undefined)}
          onToggle={() => void toggleColors()}
        />
      )}
      {!hillshade && (
        <ChoiceRow<string>
          label={t("style_editor.colors_kind")}
          value={stops ? "stops" : "palette"}
          options={["palette", "stops"].map((v) => ({
            value: v,
            label: t(`style_editor.colors_${v}`),
            sub: t(`style_editor.colors_${v}_sub`),
          }))}
          onChange={setKind}
        />
      )}
      {stops ? (
        <StopsEditor />
      ) : (
        colored && (
          <>
            <ChoiceRow<string>
              label={t("style_editor.method")}
              value={method}
              // A method the panel does not offer (heads and tails, from a style written elsewhere) shows while set.
              options={(METHODS.includes(method) ? METHODS : [...METHODS, method]).map((m) => {
                // Geometric intervals need values above 0; a method the raster service computed no breaks for on this
                // band (a formula, a band of one value) is not offered either.
                const negative = m === "geometric_interval" && geometricRefused(info, render.band ?? 1);
                const missing = negative || (BREAK_METHODS.includes(m) && countsOf(m).length === 0);
                return {
                  value: m,
                  label: t(
                    m === "continuous" ? "style_editor.raster_method_continuous" : `style_editor.method_${m}`
                  ),
                  // The band's own lowest value, as the range boxes write it, says why.
                  sub: negative
                    ? t("style_editor.geometric_band_below", {
                        min: plainNumber(bandRange(info, sampled)?.[0] ?? 0, i18n.language),
                      })
                    : t(missing ? "style_editor.no_breaks_for_band" : methodSub(m)),
                  disabled: missing,
                };
              })}
              onChange={setMethod}
            />
            {classify && (
              <ChoiceRow<number>
                label={t("style_editor.classes")}
                value={count}
                options={withStored(countsOf(method), count).map((n) => ({
                  value: n,
                  label: t("style_editor.count_classes", { count: n, defaultValue: String(n) }),
                }))}
                onChange={(n) => classesBy(method, n)}
              />
            )}
            {classify && <ClassesNotes />}
            <NavRow
              label={t("style_editor.palette")}
              value={paletteLabel(
                (render.palette ?? DEFAULTS["continuous.palette"]) as string | string[],
                render.reverse === true,
                t
              )}
              swatch={{ background: paletteStrip(colors, stepped) ?? "transparent", wide: true }}
              onOpen={openPalette}
            />
            {(ranged || outer) && (
              <Row label={t("style_editor.range")}>
                {/* With classes an end counts as a whole number typed (when its box is left, or on Enter): a digit on
                    the way would split or bound the classes anew and drop what is set on them. A continuous palette's
                    range is written as it is typed. */}
                <Box sx={{ display: "flex", gap: 2, alignItems: "center", flex: 1, minWidth: 0 }}>
                  <NumberInput
                    value={shown[0]}
                    ariaLabel={t("style_editor.range_lowest")}
                    commitOnLeave={classify !== null}
                    onChange={(v) =>
                      outer
                        ? setEnd("from", v)
                        : store.update((doc) => withRange(doc, [v, domain[1]]), "render.domain")
                    }
                  />
                  <NumberInput
                    value={shown[1]}
                    ariaLabel={t("style_editor.range_highest")}
                    commitOnLeave={classify !== null}
                    onChange={(v) =>
                      outer
                        ? setEnd("to", v)
                        : store.update((doc) => withRange(doc, [domain[0], v]), "render.domain")
                    }
                  />
                </Box>
              </Row>
            )}
            {ranged && (
              <Row note={note ?? t("style_editor.range_from_data_note")}>
                <Button variant="text" size="small" color="inherit" onClick={() => void fromData()}>
                  {t("style_editor.range_from_data")}
                </Button>
              </Row>
            )}
            {bins.length > 0 && (
              <Box sx={{ px: 3, py: 1 }}>
                <Histogram
                  bins={bins}
                  breaks={[]}
                  colorAt={colorAt}
                  // The numbers as the range boxes show them.
                  format={(n) => plainNumber(n, i18n.language)}
                  handles={handles}
                  integer={wholeBand(info, render.band ?? 1)}
                />
              </Box>
            )}
            <OutsideRow />
            {/* A continuous palette's colors to edit, at the bottom; classes are edited in their rows. */}
            {!classify && (
              <PaletteColors useSource={useRasterPalette} args={undefined} pickerKey="raster:palette" />
            )}
            {classify && (
              <Box sx={{ py: 1 }}>
                <RasterClassList kind="classes" />
              </Box>
            )}
          </>
        )
      )}
      {stops && <OutsideRow />}
    </>
  );
}

/** What the style check says about the classes (fewer than asked, and why). */
function ClassesNotes() {
  const issues = useIssueAt("render.classify").filter(
    (issue) => !/^\/render\/classify\/classes\//.test(issue.path)
  );
  if (!issues.length) return null;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1, px: 3, py: 1 }}>
      {issues.map((issue, i) => (
        <IssueNotice key={`${issue.code}-${i}`} issue={issue} />
      ))}
    </Box>
  );
}

/** What cells beyond a color range (its range, its first and last stop, or its classes' outer ends) draw: the end
 * colors, or nothing. */
function OutsideRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const outside = useStyleValue<unknown>("render.outside");
  return (
    <ChoiceRow<string>
      label={t("style_editor.outside")}
      value={outside === "hide" ? "hide" : "clamp"}
      options={["clamp", "hide"].map((v) => ({
        value: v,
        label: t(`style_editor.outside_${v}`),
        sub: t(`style_editor.outside_${v}_sub`),
      }))}
      onChange={(v) => store.set("render.outside", v === "clamp" ? undefined : v)}
    />
  );
}

/** The palette of a continuous color range as its list edits it. An edit is a palette picked (`setRasterPalette`). */
function useRasterPalette(): PaletteSource {
  const store = useEditor();
  const { raster } = useStyleData();
  const value = useStyleValue<unknown>("render");
  const unit = useStyleValue<unknown>("legend.unit");
  const render: JsonObject = isObject(value) ? value : {};
  const palette = (render.palette ?? DEFAULTS["continuous.palette"]) as string | string[];
  // The rows name where their colors sit over the range the colors cover.
  const [d0, d1] = rangeOf(render, raster?.info);
  return {
    colors: paletteList(palette, { reverse: render.reverse === true }),
    valueAt: (t) => d0 + t * (d1 - d0),
    ...(typeof unit === "string" && unit ? { unit } : {}),
    write: (colors) =>
      store.update(
        (doc) => setRasterPalette(setRasterPalette(doc, "palette", colors), "reverse", undefined),
        "render.palette"
      ),
  };
}

function RasterPalettePicker({ steps }: { steps?: number }) {
  const store = useEditor();
  const palette = useStyleValue<string | string[] | undefined>("render.palette");
  const reverse = useStyleValue<boolean | undefined>("render.reverse");
  return (
    <PalettePicker
      value={palette ?? (DEFAULTS["continuous.palette"] as string)}
      reverse={reverse === true}
      steps={steps}
      kinds={["sequential", "diverging"]}
      onChange={(next) => store.update((doc) => setRasterPalette(doc, "palette", next), "render.palette")}
      onReverse={(next) =>
        store.update((doc) => setRasterPalette(doc, "reverse", next || undefined), "render.reverse")
      }
    />
  );
}
