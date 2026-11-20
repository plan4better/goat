"use client";

// Clusters (spec 8.2): how they look (circles or like the points) and where the count goes (in the middle
// or on a badge), the circle or badge color and the number's color, the circles' smallest and largest size, the
// distance within which points merge, the zoom from which single points show, and the fewest points a cluster takes.
// Editing a cluster color or size writes out the default cluster symbol first, so the circles keep their size by
// count and their count label.
import { Slider, Typography } from "@mui/material";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { DEFAULT_CLUSTER_SYMBOL } from "@/lib/style/compile/render";
import { SLIDERS, withStored } from "@/lib/style/editor/defaults";
import {
  clusterFallback,
  clusterValueDomain,
  withClusterSymbol,
  withClusterValue,
} from "@/lib/style/editor/parts";
import { type Path, getIn, setIn } from "@/lib/style/editor/store";
import { choiceLabel } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { isObject } from "@/lib/style/json";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { ChoiceRow, MAX_ZOOM, PanelSection, Row, SliderRow } from "@/components/map/panels/styleEditor/rows";
import { ValueRow } from "@/components/map/panels/styleEditor/sections/H3Section";
import { DomainRow } from "@/components/map/panels/styleEditor/sections/HeatmapSection";

const LOOKS = ["circle", "points"];
const VALUE_OPS = ["sum", "mean", "min", "max"];
const COUNTS = ["center", "badge"];
/** Every whole zoom (spec: 0 to 24); a stored zoom between them is added (`withStored`). */
const UNTIL_ZOOMS = Array.from({ length: MAX_ZOOM + 1 }, (_, z) => z);
/** 2 to 20 points (spec: from 2); a stored count above them is added. */
const MIN_POINTS = Array.from({ length: 19 }, (_, i) => i + 2);

function ClusterColorRow({ label, symbolKey }: { label: string; symbolKey: string }) {
  const store = useEditor();
  useStyleValue("render.symbol");
  const path: Path = `render.symbol.${symbolKey}`;
  return (
    <ColorRow
      label={label}
      path={path}
      fallback={clusterFallback(store.document, symbolKey) as string | undefined}
      write={(value) => store.update((doc) => setIn(withClusterSymbol(doc), path, value), path)}
    />
  );
}

const SIZE: Path = "render.symbol.marker.size";

/** The smallest and the largest cluster circle (px): the range of the size by count or by the clusters' value, which
 * keeps its scale and domain; a fixed size is both ends, and an edit sizes the circles by count (the default symbol's
 * scale). */
function ClusterSizeRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  useStyleValue("render.symbol");
  const size = getIn(store.document, SIZE) ?? clusterFallback(store.document, "marker.size");
  const fixed = typeof size === "number" ? size : (DEFAULTS["marker.size"] as number);
  const range: [number, number] =
    isObject(size) && Array.isArray(size.range) ? (size.range as [number, number]) : [fixed, fixed];
  const bounds = SLIDERS["marker.size"];
  const write = ([a, b]: number[]) =>
    store.update((doc) => {
      const out = withClusterSymbol(doc);
      const now = getIn(out, SIZE);
      return isObject(now) && (now.field === "count" || now.field === "value")
        ? setIn(out, `${SIZE}.range`, [a, b])
        : setIn(out, SIZE, { ...DEFAULT_CLUSTER_SYMBOL.marker.size, range: [a, b] });
    }, SIZE);
  return (
    <Row label={t("style_editor.size")}>
      <Slider
        size="small"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={range.map((end) => Math.min(Math.max(end, bounds.min), bounds.max))}
        getAriaLabel={(index) =>
          t(index === 0 ? "style_editor.range_smallest" : "style_editor.range_largest")
        }
        onChange={(_, next) => write(next as number[])}
        sx={{ flex: 1, minWidth: 0, ml: 1, mr: 1 }}
      />
      <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: "none" }}>
        {`${range[0]} ${t("style_editor.to")} ${range[1]} ${bounds.unit}`}
      </Typography>
    </Row>
  );
}

export function ClusterSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry, profiles } = useStyleData();
  const type = useStyleValue<unknown>("render.type");
  const radius = useStyleValue<unknown>("render.radius");
  const until = useStyleValue<unknown>("render.cluster_until_zoom");
  const minPoints = useStyleValue<unknown>("render.min_points");
  const look = useStyleValue<unknown>("render.look") ?? DEFAULTS["cluster.look"];
  const count = useStyleValue<unknown>("render.count") ?? DEFAULTS["cluster.count"];
  const value = useStyleValue<unknown>("render.value");
  const size = useStyleValue<unknown>(SIZE);
  // Stops waiting for the range of the field picked last: a new pick or the section going away.
  const waiting = useRef<(() => void) | null>(null);
  const stopWaiting = () => {
    waiting.current?.();
    waiting.current = null;
  };
  useEffect(() => stopWaiting, []);
  if (geometry !== "point" || type !== "cluster") return null;
  const byValue = isObject(value) && value.op !== "count" && isObject(size) && size.field === "value";
  // A value by a field starts the size's range at the field's (spec 8.2): written with the pick, or once when the
  // field's profile arrives.
  const writeValue = (next: { op: string; field: string } | undefined) => {
    stopWaiting();
    const domain = next ? clusterValueDomain(next.op, profiles.get(next.field)) : undefined;
    store.update((doc) => withClusterValue(doc, next, domain), "render");
    if (!next || domain) return;
    waiting.current = profiles.subscribe(() => {
      const range = clusterValueDomain(next.op, profiles.get(next.field));
      if (!range) return;
      stopWaiting();
      const now = store.get("render.value");
      if (isObject(now) && now.field === next.field && now.op === next.op)
        store.update((doc) => withClusterValue(doc, next, range), "render");
    });
    profiles.load(next.field);
  };
  const range = SLIDERS["cluster.radius"];
  const number = (value: unknown, key: string) =>
    typeof value === "number" ? value : (DEFAULTS[key] as number);
  return (
    <PanelSection title={t("style_editor.section_clusters")}>
      <ChoiceRow<string>
        label={t("style_editor.look")}
        value={String(look)}
        options={LOOKS.map((value) => ({ value, label: choiceLabel(t, "render.look", value) }))}
        onChange={(value) => store.set("render.look", value)}
      />
      <ChoiceRow<string>
        label={t("style_editor.count")}
        value={String(count)}
        options={COUNTS.map((value) => ({ value, label: choiceLabel(t, "render.count", value) }))}
        onChange={(value) => store.set("render.count", value)}
      />
      <ValueRow ops={VALUE_OPS} onChange={writeValue} />
      <ClusterColorRow label={t("style_editor.color")} symbolKey="marker.color" />
      <ClusterColorRow label={t("style_editor.cluster_number_color")} symbolKey="label.color" />
      {look !== "points" && <ClusterSizeRow />}
      {look !== "points" && byValue && <DomainRow path={`${SIZE}.domain`} />}
      <SliderRow
        label={t("style_editor.merge_distance")}
        min={range.min}
        max={range.max}
        step={range.step}
        unit={range.unit}
        value={number(radius, "cluster.radius")}
        onChange={(next) => store.set("render.radius", next)}
      />
      <ChoiceRow<string>
        label={t("style_editor.until")}
        value={String(number(until, "cluster.cluster_until_zoom"))}
        options={withStored(UNTIL_ZOOMS, until).map((z) => ({
          value: String(z),
          label: t("style_editor.zoom_n", { zoom: z }),
        }))}
        onChange={(value) => store.set("render.cluster_until_zoom", Number(value))}
      />
      <ChoiceRow<string>
        label={t("style_editor.smallest")}
        value={String(number(minPoints, "cluster.min_points"))}
        options={withStored(MIN_POINTS, minPoints).map((n) => ({
          value: String(n),
          label: t("style_editor.n_points", { count: n }),
        }))}
        onChange={(value) => store.set("render.min_points", Number(value))}
      />
    </PanelSection>
  );
}
