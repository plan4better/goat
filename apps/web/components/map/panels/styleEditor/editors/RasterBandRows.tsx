"use client";

// The Band row of a raster file's General section (spec 9.3) and the rows under it: the band a color range, categories
// or a hillshade reads; for a color range or a hillshade also band math: an index (NDVI, NDMI, NDWI) over two input
// bands, which the file's color interpretation or band names fill in where they name them, else wait to be picked; or a
// formula of its own, checked as goatlib checks it while it is typed and written when it is left or Enter is pressed. A
// formula shows as its index and bands, else as itself; a band replaces it only when it is picked from the menu.
import { Box } from "@mui/material";
import type { TFunction } from "i18next";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type RasterRenderType,
  categoriesOf,
  equalClasses,
  rasterClassesRender,
} from "@/lib/style/editor/raster";
import { getIn, setIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  FORMULA_PRESETS,
  type FormulaPreset,
  PRESET_DOMAIN,
  bandOrFormula,
  checkFormula,
  formulaLabel,
  formulaOf,
  formulaProblemText,
  normalizedDifference,
  presetBands,
  presetOf,
} from "@/lib/style/raster/formula";
import { type RasterInfo, bandBreaks, bandLabel, seedDomain, valueBands } from "@/lib/style/raster/metadata";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import {
  useEditor,
  useRasterSample,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { type ChoiceOption, ChoiceRow, Row } from "@/components/map/panels/styleEditor/rows";

type Inputs = [number | undefined, number | undefined];
/** Band math picked but not written yet: an index whose input bands are not all picked, or a formula being typed. */
type Pending = { kind: "preset"; preset: FormulaPreset; bands: Inputs } | { kind: "formula" };
type BandFormula = { name: string; expression: string };

/** The two input bands, where both are picked and differ. */
const complete = (bands: Inputs): [number, number] | null =>
  bands[0] !== undefined && bands[1] !== undefined && bands[0] !== bands[1] ? [bands[0], bands[1]] : null;

/** Which of an image's colour channels a band colored by a color range or categories is (the file's colour
 * interpretation), so a washed-out result reads as what it is: one channel of a photo. */
function channelNote(
  info: RasterInfo | undefined,
  band: number,
  type: string,
  t: TFunction
): string | undefined {
  const channel = info?.colorInterp?.[band - 1];
  if (
    (type !== "continuous" && type !== "categorical") ||
    !channel ||
    !["red", "green", "blue"].includes(channel)
  )
    return undefined;
  // The file's band name as it is: React escapes it, i18next must not as well.
  return t(`style_editor.band_channel_${channel}`, {
    band: bandLabel(info, band, t),
    interpolation: { escapeValue: false },
  });
}

/** The computed method and class count (`quantile:5`) of a color range's or hillshade's classes that are not written
 * yet: the breaks come with the info of the band or formula the style reads, which is asked for only once the style
 * names it. "" for classes that are there, and for any other render. */
function awaitedClasses(doc: { render?: unknown }): string {
  const render = doc.render;
  if (!isObject(render) || (render.type !== "continuous" && render.type !== "hillshade")) return "";
  const classify = render.classify;
  if (!isObject(classify) || typeof classify.method !== "string" || typeof classify.count !== "number")
    return "";
  if (classify.method === "manual" || classify.method === "equal_interval") return "";
  if (Array.isArray(classify.classes) && classify.classes.length) return "";
  return `${classify.method}:${classify.count}`;
}

/** A formula typed by hand: the note under it says what is wrong as it is typed (else what a formula may use); it is
 * written once it is left or Enter is pressed, and only when goatlib would read it. */
function FormulaRow({
  expression,
  held,
  onCommit,
}: {
  expression: string;
  /** The file's bands of values; undefined before its info answered (any band then). */
  held?: number[];
  onCommit: (expression: string) => void;
}) {
  const { t } = useTranslation("common");
  const [draft, setDraft] = useState(expression);
  // Another formula written (an undo, a preset): the box shows it.
  useEffect(() => setDraft(expression), [expression]);
  const checked = draft.trim() ? checkFormula(draft, held) : null;
  const commit = () => {
    if (checked?.ok && draft.trim() !== expression.trim()) onCommit(draft.trim());
  };
  const label = t("style_editor.formula");
  return (
    <Row
      label={label}
      note={
        checked && !checked.ok ? (
          <Box component="span" sx={{ color: "error.main" }}>
            {formulaProblemText(checked.problem, t)}
          </Box>
        ) : (
          t("style_editor.formula_hint")
        )
      }>
      <TextFieldInput
        value={draft}
        placeholder="(b1 - b2) / (b1 + b2)"
        clearable={false}
        inputProps={{
          "aria-label": label,
          spellCheck: false,
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Enter") commit();
          },
        }}
        onChange={setDraft}
        onBlur={commit}
      />
    </Row>
  );
}

export function RasterBandRows({ type }: { type: RasterRenderType }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { raster } = useStyleData();
  const sample = useRasterSample();
  const bandValue = useStyleValue<unknown>("render.band");
  const [pending, setPending] = useState<Pending | null>(null);
  const info = raster?.info;
  const formula = formulaOf(bandValue);
  const preset = presetOf(bandValue);
  const band = typeof bandValue === "number" ? bandValue : 1;
  // Another band or formula written (an undo, a paste): what was picked but not written goes.
  const written = JSON.stringify(bandValue ?? 1);
  useEffect(() => setPending(null), [written]);

  // Another band or formula under a computed method is written without classes while the info shown is still the
  // band's before it: its breaks arrive with its own info, and the classes are written then, once per document (an
  // undo back to it stays as it is).
  const awaited = useStyleSelector(awaitedClasses);
  const refilled = useRef(new WeakSet<object>());
  useEffect(() => {
    if (!awaited || !info) return;
    const document = store.document;
    const now = store.get("render");
    if (refilled.current.has(document) || !isObject(now)) return;
    const [method, n] = awaited.split(":");
    const count = Number(n);
    if (bandBreaks(info, bandOrFormula(now.band), method, count) === undefined) return;
    refilled.current.add(document);
    store.update((doc) => setIn(doc, "render", rasterClassesRender(now, method, count, info)), "render.band");
  }, [awaited, info, written, store]);

  /** A range from the values of a band or formula. A formula's values take a request: they are dropped where the
   * render reads another band or formula by then, or is drawn another way. */
  const seedFromData = async (from: number | string, kind: RasterRenderType) => {
    const found = await sample(from);
    if (!found || !info) return;
    const now = store.get("render");
    if (!isObject(now) || now.type !== kind || bandOrFormula(now.band) !== from) return;
    if (kind === "continuous" || kind === "hillshade") {
      const domain = seedDomain(found, info);
      if (!domain) return;
      store.update((doc) => {
        const render = getIn(doc, "render");
        const classify = isObject(render) && isObject(render.classify) ? render.classify : null;
        const classes = classify && Array.isArray(classify.classes) ? classify.classes : [];
        const method = typeof classify?.method === "string" ? classify.method : "manual";
        // Equal intervals split the band's range.
        if (isObject(render) && classify && method === "equal_interval") {
          const count = typeof classify.count === "number" ? classify.count : classes.length || 5;
          return setIn(doc, "render", rasterClassesRender({ ...render, domain }, method, count, info));
        }
        let next = setIn(doc, "render.domain", domain);
        if (classes.length)
          next = setIn(next, "render.classify.classes", equalClasses(domain, classes.length));
        return next;
      });
    }
  };

  /** Another band, or a formula typed by hand: categories take a band's codes (the other values' color kept); classes
   * the values classify themselves (quantiles, natural breaks, ...) take its breaks, at once where the info has them,
   * else when its info arrives; a range and its equal or manual classes start from its values. */
  const setBand = (next: number | BandFormula) => {
    const render = store.get("render");
    const classify = isObject(render) && isObject(render.classify) ? render.classify : null;
    const method = typeof classify?.method === "string" ? classify.method : "manual";
    const computed = !!classify && method !== "manual" && method !== "equal_interval";
    store.update((doc) => {
      const out = setIn(doc, "render.band", next === 1 ? undefined : next);
      const now = getIn(out, "render");
      if (!isObject(now)) return out;
      if (type === "categorical" && typeof next === "number")
        return setIn(out, "render.classes", categoriesOf(info, next) ?? undefined);
      if (computed && isObject(now.classify)) {
        const classes = Array.isArray(now.classify.classes) ? now.classify.classes : [];
        const count = typeof now.classify.count === "number" ? now.classify.count : classes.length || 5;
        return setIn(out, "render", rasterClassesRender(now, method, count, info));
      }
      return out;
    }, "render.band");
    // A color range, and shading in colors, start their range from the new values.
    const colored =
      type === "continuous" || (type === "hillshade" && isObject(render) && render.palette != null);
    if (colored && !computed) void seedFromData(typeof next === "number" ? next : next.expression, type);
  };

  /** An index over `bands`. A new one starts as a color range over -1 to 1 in its palette (shading keeps its own
   * colors, over that range); other input bands keep the colors. */
  const writePreset = (chosen: FormulaPreset, bands: [number, number], fresh: boolean) =>
    store.update((doc) => {
      const value = { name: chosen.name, expression: normalizedDifference(bands[0], bands[1]) };
      const now = getIn(doc, "render");
      if (!fresh || !isObject(now)) return setIn(doc, "render.band", value);
      const next: JsonObject = { ...now, band: value };
      delete next.computed;
      if (type === "continuous") {
        for (const key of ["stops", "interpolate", "classify", "reverse"]) delete next[key];
        next.palette = chosen.palette;
        next.domain = [...PRESET_DOMAIN];
      } else if (next.palette != null) {
        delete next.classify;
        next.domain = [...PRESET_DOMAIN];
      }
      return setIn(doc, "render", next);
    }, "render.band");

  const pickPreset = (chosen: FormulaPreset) => {
    if (preset?.preset.id === chosen.id) return setPending(null);
    const bands = presetBands(info, chosen);
    const both = complete(bands);
    if (both) {
      setPending(null);
      writePreset(chosen, both, true);
    } else setPending({ kind: "preset", preset: chosen, bands });
  };

  /** A formula typed by hand keeps a name of its own; else it is named by itself (the popup's label for the value). */
  const commitFormula = (expression: string) => {
    const name = formula?.name.trim() ?? "";
    const own =
      !!name &&
      name !== formula?.expression.trim() &&
      !FORMULA_PRESETS.some((p) => p.name.toLowerCase() === name.toLowerCase());
    setPending(null);
    setBand({ name: own ? name : expression, expression });
  };

  const held = valueBands(info);
  const ownBands = info ? held : [1];
  const math = type === "continuous" || type === "hillshade";
  // A file of one band has the row where a formula is possible (a color range, a hillshade), or one is set; before the
  // file's info answered, only for a formula.
  if (!formula && (!info || (ownBands.length <= 1 && !math))) return null;
  const current: string =
    pending?.kind === "preset"
      ? `preset:${pending.preset.id}`
      : pending?.kind === "formula" || (formula && !preset)
        ? "formula"
        : preset
          ? `preset:${preset.preset.id}`
          : `band:${band}`;
  const bandOptions = ownBands.map((index) => ({ value: index, label: bandLabel(info, index, t) }));
  const presetOptions: ChoiceOption<string>[] = FORMULA_PRESETS.map((p) => ({
    value: `preset:${p.id}`,
    label: p.name,
    short: preset?.preset.id === p.id && !pending ? formulaLabel(bandValue, info, t) : p.name,
    sub: t(`style_editor.preset_${p.id}_sub`),
  }));
  const formulaOption: ChoiceOption<string> = {
    value: "formula",
    label: t("style_editor.band_formula"),
    short: formula && !preset ? formula.expression.trim() : t("style_editor.band_formula"),
    sub: t("style_editor.band_formula_sub"),
  };
  // Band math needs two bands of values; a formula a style already colors shows as it is. A plain divider sets it
  // apart from the bands.
  const mathOptions = [
    ...(math && ownBands.length > 1 ? presetOptions : presetOptions.filter((o) => o.value === current)),
    ...(math || current === "formula" ? [formulaOption] : []),
  ].map((o, i) => (i === 0 ? { ...o, divider: true } : o));
  const options: ChoiceOption<string>[] = [
    ...bandOptions.map((o) => ({ value: `band:${o.value}`, label: o.label })),
    ...mathOptions,
  ];
  const onPick = (value: string) => {
    if (value.startsWith("band:")) {
      const next = Number(value.slice(5));
      setPending(null);
      if (formula || next !== band) setBand(next);
    } else if (value.startsWith("preset:")) {
      const chosen = FORMULA_PRESETS.find((p) => `preset:${p.id}` === value);
      if (chosen) pickPreset(chosen);
    } else if (value === "formula" && (!formula || preset)) setPending({ kind: "formula" });
  };

  // The index's input bands: those written, or those picked so far.
  const inputs =
    pending?.kind === "preset"
      ? { chosen: pending.preset, bands: pending.bands, fresh: true }
      : !pending && preset
        ? { chosen: preset.preset, bands: preset.bands as Inputs, fresh: false }
        : null;
  const pickInput = (i: 0 | 1, next: number) => {
    if (!inputs) return;
    const bands: Inputs = [...inputs.bands];
    // The band the other input holds: the two swap, so a written index stays one and keeps its colors. An input not
    // picked yet has nothing to give back: both then hold the same band, which waits (`twice`).
    const other = i === 0 ? 1 : 0;
    if (bands[other] === next && bands[i] !== undefined) bands[other] = bands[i];
    bands[i] = next;
    const both = complete(bands);
    if (both) {
      setPending(null);
      writePreset(inputs.chosen, both, inputs.fresh);
    } else setPending({ kind: "preset", preset: inputs.chosen, bands });
  };
  // An index compares two bands: twice the same one (reachable only while a new index is picked) is not written.
  const twice = !!inputs && inputs.bands[0] !== undefined && inputs.bands[0] === inputs.bands[1];
  const typing = pending?.kind === "formula" || (!pending && formula && !preset);
  return (
    <>
      <ChoiceRow<string>
        label={t("style_editor.band")}
        value={current}
        options={options}
        note={formula || pending ? undefined : channelNote(info, band, type, t)}
        onChange={onPick}
      />
      {inputs &&
        inputs.chosen.inputs.map((role, i) => (
          <ChoiceRow<number>
            key={role}
            label={t(`style_editor.band_${role}`)}
            value={inputs.bands[i] ?? 0}
            options={bandOptions}
            placeholder={t("style_editor.band_pick")}
            note={twice && i === 1 ? t("style_editor.band_inputs_same") : undefined}
            onChange={(next) => pickInput(i as 0 | 1, next)}
          />
        ))}
      {typing && (
        <FormulaRow
          expression={formula?.expression ?? ""}
          held={info ? held : undefined}
          onCommit={commitFormula}
        />
      )}
    </>
  );
}
