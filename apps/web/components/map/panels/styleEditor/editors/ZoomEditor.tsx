"use client";

// A value by zoom (spec 4.2, prototype 4.3): the stop chart, the selected stop's zoom and value, and the transition
// between stops. A stop may hold a value by attribute (spec 4.4); it opens the attribute editor on that stop.
import { IconButton, Typography, useTheme } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { defaultResolveIcon } from "@/lib/style/compile/images";
import { SLIDERS } from "@/lib/style/editor/defaults";
import { fixedValue, keyOf } from "@/lib/style/editor/forms";
import { type Path, getIn, setIn } from "@/lib/style/editor/store";
import { choiceLabel } from "@/lib/style/editor/summaries";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, clone, isObject } from "@/lib/style/json";
import { MARKER_SHAPES } from "@/lib/style/markerShapes";

import {
  useEditor,
  useLiveMapZoom,
  useMapZoom,
  useStyleData,
  useStyleValue,
  useZoomTo,
} from "@/components/map/panels/styleEditor/context";
import { AttributeEditor } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { IconRow } from "@/components/map/panels/styleEditor/editors/IconRow";
import { markerRecordOf, useShapeState } from "@/components/map/panels/styleEditor/editors/ShapeField";
import {
  type Stops,
  ZOOM_MAX,
  ZOOM_MIN,
  ZoomStopChart,
} from "@/components/map/panels/styleEditor/editors/ZoomStopChart";
import { DASH_ARRAYS } from "@/components/map/panels/styleEditor/editors/choiceGlyph";
import { PatternPicture, PatternTiles } from "@/components/map/panels/styleEditor/pickers/PatternTiles";
import { SHAPE_NEUTRAL } from "@/components/map/panels/styleEditor/pickers/ShapeTiles";
import { useSymbols } from "@/components/map/panels/styleEditor/pickers/iconRefs";
import {
  anchorTopOf,
  useCloseWhenGone,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, FormButton, NumberInput, Row, SliderRow } from "@/components/map/panels/styleEditor/rows";

const SMOOTH_BASE = 1.6;
const TRANSITIONS = ["linear", "smooth", "steps"];
const HEX = /^#[0-9a-f]{6}/i;

/** The stop nearest the map zoom (the first on a tie). */
const nearest = (stops: Stops, zoom: number) =>
  stops.reduce((best, [z], i) => (Math.abs(z - zoom) < Math.abs(stops[best][0] - zoom) ? i : best), 0);

/** What a stop's glyph draws for an attribute form: its value at the domain start. */
function shownValue(value: unknown): unknown {
  if (!isObject(value)) return value;
  if (Array.isArray(value.range)) return value.range[0];
  if (Array.isArray(value.palette)) return value.palette[0];
  if (typeof value.palette === "string") return PALETTES[value.palette]?.colors[0];
  return undefined;
}

const clampNumber = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** An icon stop: a library symbol in the text color, emoji and uploads as their images; in the marker's shape where
 * it has one (the icon in the icon color, in the shape's head). */
function IconStopGlyph({ iconRef, record }: { iconRef: string; record: Path }) {
  const theme = useTheme();
  const symbols = useSymbols();
  const look = useShapeState(record);
  const symbol = iconRef.startsWith("goat:") ? symbols?.get(iconRef.slice("goat:".length)) : undefined;
  const url = defaultResolveIcon(iconRef)?.url;
  const icon = (x: number, y: number, side: number, color: string) =>
    symbol ? (
      <svg x={x} y={y} width={side} height={side} viewBox={symbol.viewBox} fill={color}>
        {symbol.paths.map((d, i) => (
          <path key={i} d={d} fillRule={symbol.evenodd ? "evenodd" : undefined} />
        ))}
      </svg>
    ) : url ? (
      <image href={url} x={x} y={y} width={side} height={side} />
    ) : null;
  if (look.shape === "icon") return icon(-9, -9, 18, theme.palette.text.primary);
  const spec = MARKER_SHAPES[look.shape];
  const side = 22;
  const iconSide = spec.icon.share * side;
  return (
    <g>
      <svg x={-side / 2} y={-side / 2} width={side} height={side} viewBox="0 0 24 24">
        <path d={spec.path} fill={look.preview.fill ?? SHAPE_NEUTRAL} />
      </svg>
      {icon(
        -side / 2 + (spec.icon.cx / 24) * side - iconSide / 2,
        -side / 2 + (spec.icon.cy / 24) * side - iconSide / 2,
        iconSide,
        look.preview.iconColor ?? "#ffffff"
      )}
    </g>
  );
}

/** A stop's value as a small picture: a dot of its color, a line of its width, a circle of its size, … */
function StopGlyph({
  propertyKey,
  value,
  color,
  path,
}: {
  propertyKey: string;
  value: unknown;
  color: string;
  /** The property's path: an icon draws in its marker's shape. */
  path: Path;
}) {
  const { t } = useTranslation("common");
  const shown = shownValue(value);
  const kind = CAPABILITIES[propertyKey]?.kind ?? "choice";
  if (kind === "color")
    return (
      <circle r={7} fill={typeof shown === "string" ? shown : "none"} stroke={color} strokeWidth={0.5} />
    );
  if (propertyKey === "fill.pattern")
    return typeof shown === "string" && shown !== "none" ? (
      <g transform="translate(-9 -9)" style={{ color }}>
        <PatternPicture kind={shown} size={18} />
      </g>
    ) : (
      <text fontSize={9} textAnchor="middle" dominantBaseline="middle" fill={color}>
        {choiceLabel(t, propertyKey, "none")}
      </text>
    );
  if (propertyKey === "marker.icon")
    return typeof shown === "string" ? <IconStopGlyph iconRef={shown} record={markerRecordOf(path)} /> : null;
  if (propertyKey === "label.font.weight")
    return (
      <text
        fontSize={13}
        textAnchor="middle"
        dominantBaseline="middle"
        fontWeight={shown === "bold" ? 700 : 400}
        fill={color}>
        Aa
      </text>
    );
  if (propertyKey.endsWith(".dash"))
    return (
      <line x1={-11} x2={11} stroke={color} strokeWidth={2} strokeDasharray={DASH_ARRAYS[String(shown)]} />
    );
  if (typeof shown !== "number")
    return (
      <text fontSize={9} textAnchor="middle" dominantBaseline="middle" fill={color}>
        {shown === undefined ? "" : choiceLabel(t, propertyKey, shown)}
      </text>
    );
  if (propertyKey.endsWith("opacity"))
    return <rect x={-7} y={-7} width={14} height={14} fill={color} fillOpacity={clampNumber(shown, 0, 1)} />;
  if (propertyKey === "label.size")
    return (
      <text fontSize={clampNumber(shown, 7, 22)} textAnchor="middle" dominantBaseline="middle" fill={color}>
        Aa
      </text>
    );
  if (propertyKey.endsWith("width") || propertyKey.endsWith("offset") || propertyKey.endsWith("blur"))
    return (
      <line
        x1={-8}
        y1={8}
        x2={8}
        y2={-8}
        stroke={color}
        strokeWidth={clampNumber(Math.abs(shown), 0.5, 10)}
      />
    );
  return <circle r={clampNumber(shown / 2, 1.5, 12)} fill={color} />;
}

export function ZoomEditor({ path, choices }: { path: Path; choices?: readonly string[] }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const mapZoom = useMapZoom();
  const liveZoom = useLiveMapZoom();
  const zoomTo = useZoomTo();
  const popover = usePopover();
  const next = useNextLevel();
  const form = useStyleValue<unknown>(path);
  const layerFrom = useStyleValue<number | undefined>("min_zoom");
  const layerUntil = useStyleValue<number | undefined>("max_zoom");
  const partColor = useStyleValue<unknown>(`${path.slice(0, path.lastIndexOf("."))}.color`);
  const stops = (isObject(form) && Array.isArray(form.zoom) ? form.zoom : []) as Stops;
  const [selected, setSelected] = useState(() => (stops.length ? nearest(stops, mapZoom) : 0));
  // Made fixed (or by attribute) while open, by the row's mode or an undo: the editor closes.
  const gone = !isObject(form) || stops.length < 2;
  useCloseWhenGone(gone);
  if (gone)
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 2 }}>
        {t("style_editor.not_by_zoom")}
      </Typography>
    );

  const key = keyOf(path);
  const cap = CAPABILITIES[key];
  const kind = cap?.kind ?? "choice";
  const stepOnly = cap?.zoom === "step";
  const index = Math.min(selected, stops.length - 1);
  const [zoom, value] = stops[index];
  const stopPath = `${path}.zoom.${index}.1`;
  const glyphColor = typeof partColor === "string" && HEX.test(partColor) ? partColor : "#6b7280";
  const writeStops = (nextStops: Stops) => store.set(`${path}.zoom`, nextStops);

  const add = (z: number): number => {
    const at = stops.findIndex(([s]) => s > z);
    const i = at < 0 ? stops.length : at;
    const left = stops[Math.max(0, i - 1)][1];
    const right = stops[Math.min(stops.length - 1, i)][1];
    // A stop between attribute forms copies its neighbor; plain values follow the current curve.
    const v =
      isObject(left) || isObject(right)
        ? clone(isObject(left) ? left : right)
        : fixedValue(store.document, path, { mapZoom: z });
    writeStops([...stops.slice(0, i), [z, v], ...stops.slice(i)]);
    setSelected(i);
    return i;
  };

  const move = (i: number, z: number) => writeStops(stops.map((stop, k) => (k === i ? [z, stop[1]] : stop)));

  const setZoom = (z: number) => {
    const target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    if (stops.some(([s], k) => k !== index && s === target)) return;
    const moved = stops.map((stop, k) => (k === index ? ([target, stop[1]] as [number, unknown]) : stop));
    const sorted = [...moved].sort((a, b) => a[0] - b[0]);
    writeStops(sorted);
    setSelected(sorted.indexOf(moved[index]));
  };

  const remove = () => {
    writeStops(stops.filter((_, k) => k !== index));
    setSelected(Math.max(0, index - 1));
  };

  const label = t("style_editor.value");
  let valueRow;
  if (isObject(value) && typeof value.field === "string") {
    const fieldLabel = data.fields.find((f) => f.name === value.field)?.label ?? value.field;
    valueRow = (
      <Row label={label}>
        <FormButton
          text={t("style_editor.by_field", { field: fieldLabel })}
          onOpen={(anchor) =>
            popover.open(next, {
              key: `attr:${stopPath}`,
              title: t("style_editor.by_attribute_title", { label: `z${zoom}` }),
              anchorTop: anchorTopOf(anchor),
              render: () => <AttributeEditor path={stopPath} />,
            })
          }
        />
      </Row>
    );
  } else if (kind === "color") valueRow = <ColorRow label={label} path={stopPath} />;
  else if (key === "marker.icon") valueRow = <IconRow label={label} path={stopPath} />;
  else if (key === "fill.pattern")
    valueRow = (
      <PatternTiles
        label={label}
        values={choices ?? []}
        value={String(value)}
        onChange={(v) => store.set(stopPath, v)}
      />
    );
  else if (kind === "number") {
    const slider = SLIDERS[key] ?? { min: 0, max: 100, step: 1 };
    const largest = Math.max(...stops.map(([, v]) => (typeof v === "number" ? v : 0)));
    valueRow = (
      <SliderRow
        label={label}
        min={slider.min}
        max={Math.max(slider.max, largest)}
        step={slider.step}
        unit={slider.unit}
        pct={slider.pct}
        value={typeof value === "number" ? value : (DEFAULTS[key] as number)}
        onChange={(v) => store.set(stopPath, v)}
      />
    );
  } else {
    const values = choices?.length ? [...choices] : [String(value)];
    valueRow = (
      <ChoiceRow<string>
        label={label}
        value={String(value)}
        options={values.map((v) => ({ value: v, label: choiceLabel(t, key, v) }))}
        onChange={(v) => store.set(stopPath, v)}
      />
    );
  }

  const interpolate = getIn(form, "interpolate");
  const transition = interpolate === "exponential" ? "smooth" : interpolate === "step" ? "steps" : "linear";
  const setTransition = (to: string) =>
    store.update((doc) => {
      const current = getIn(doc, path) as JsonObject;
      const { interpolate: _i, base: _b, ...rest } = current;
      const nextForm =
        to === "smooth"
          ? { ...rest, interpolate: "exponential", base: SMOOTH_BASE }
          : to === "steps"
            ? { ...rest, interpolate: "step" }
            : rest;
      return setIn(doc, path, nextForm);
    });

  return (
    <>
      <ZoomStopChart
        stops={stops}
        selected={index}
        mapZoom={liveZoom}
        onZoomTo={zoomTo}
        layerRange={[layerFrom ?? ZOOM_MIN, layerUntil ?? ZOOM_MAX]}
        label={t("style_editor.zoom_chart_aria")}
        hiddenLabel={t("style_editor.layer_hidden_zooms")}
        glyph={(v) => <StopGlyph propertyKey={key} value={v} color={glyphColor} path={path} />}
        onSelect={setSelected}
        onAdd={add}
        onMove={move}
      />
      <Row
        label={t("style_editor.stop")}
        actions={
          stops.length > 2 ? (
            <IconButton
              size="small"
              title={t("style_editor.remove_stop")}
              aria-label={t("style_editor.remove_stop_aria", { zoom })}
              onClick={remove}>
              <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 12 }} />
            </IconButton>
          ) : undefined
        }>
        <Typography variant="body2" color="text.secondary">
          z
        </Typography>
        <NumberInput
          value={zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          ariaLabel={t("style_editor.stop_zoom")}
          onChange={setZoom}
        />
      </Row>
      {valueRow}
      {!stepOnly && (
        <ChoiceRow<string>
          label={t("style_editor.transition")}
          value={transition}
          options={TRANSITIONS.map((v) => ({
            value: v,
            label: t(`style_editor.transition_${v}`),
            sub: t(`style_editor.transition_${v}_sub`),
          }))}
          onChange={setTransition}
        />
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, pt: 2 }}>
        {t("style_editor.zoom_note")} {stepOnly && <span>{t("style_editor.zoom_note_step")}</span>}
      </Typography>
    </>
  );
}
