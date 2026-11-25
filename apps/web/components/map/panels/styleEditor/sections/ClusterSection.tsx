"use client";

// Clusters (spec 8.2): how they look (circles or like the points) and where the count goes (in the middle
// or on a badge), the circle or badge color and the number's color, the circles' size (a row that opens its editor),
// the distance within which points merge, the zoom from which single points show, and the fewest points a cluster
// takes. Editing a cluster color or size writes out the default cluster symbol first, so the circles keep their size
// by count and their count label.
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
import { choiceLabel, plainNumber, summarize, summaryNumber } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";

import {
  useEditor,
  useMapZoom,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { ZoomEditor } from "@/components/map/panels/styleEditor/editors/ZoomEditor";
import { PLAIN } from "@/components/map/panels/styleEditor/plainText";
import {
  anchorTopOf,
  useCloseWhenGone,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  GroupRow,
  MAX_ZOOM,
  PanelSection,
  SliderRow,
} from "@/components/map/panels/styleEditor/rows";
import { ValueModeButton } from "@/components/map/panels/styleEditor/rows/ValueModeButton";
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

const byZoom = (size: unknown) => isObject(size) && Array.isArray(size.zoom);

/** The circles' size as its smallest and largest circle (px), from low to high: the range of the size by count or by
 * the clusters' value; a fixed size is both ends. */
function sizeRange(doc: LayerStyle): [number, number] {
  const size = getIn(doc, SIZE) ?? clusterFallback(doc, "marker.size");
  const fixed = typeof size === "number" ? size : (DEFAULTS["marker.size"] as number);
  if (!(isObject(size) && Array.isArray(size.range))) return [fixed, fixed];
  const [a, b] = size.range as [number, number];
  return a <= b ? [a, b] : [b, a];
}

/** The Size editor: the smallest and the largest circle, and for a size by a value of a field the value's range. An
 * edit writes the range from low to high and keeps the size's scale and domain; on a fixed size it sizes the circles
 * by count (the default symbol's scale). An edit that leaves the range as it is writes nothing. It closes once the
 * circles have no size of their own (like the points, another render) or one by zoom. */
function ClusterSizeEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const type = useStyleValue<unknown>("render.type");
  const look = useStyleValue<unknown>("render.look") ?? DEFAULTS["cluster.look"];
  const value = useStyleValue<unknown>("render.value");
  useStyleValue("render.symbol");
  const size = getIn(store.document, SIZE) ?? clusterFallback(store.document, "marker.size");
  useCloseWhenGone(geometry !== "point" || type !== "cluster" || look === "points" || byZoom(size));
  const range = sizeRange(store.document);
  const bounds = SLIDERS["marker.size"];
  const byValue = isObject(value) && value.op !== "count" && isObject(size) && size.field === "value";
  const write = ([a, b]: number[]) => {
    if (a === range[0] && b === range[1]) return;
    store.update((doc) => {
      const out = withClusterSymbol(doc);
      const now = getIn(out, SIZE);
      return isObject(now) && (now.field === "count" || now.field === "value")
        ? setIn(out, `${SIZE}.range`, [a, b])
        : setIn(out, SIZE, { ...DEFAULT_CLUSTER_SYMBOL.marker.size, range: [a, b] });
    }, SIZE);
  };
  return (
    <>
      <SliderRow
        label={t("style_editor.range_smallest")}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        unit={bounds.unit}
        value={range[0]}
        // A typed size counts as a whole, from the slider's smallest on; the range goes from low to high: Smallest
        // stops at Largest.
        commitOnLeave
        onChange={(v) => write([Math.min(Math.max(v, bounds.min), range[1]), range[1]])}
      />
      <SliderRow
        label={t("style_editor.range_largest")}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        unit={bounds.unit}
        value={range[1]}
        commitOnLeave
        onChange={(v) => write([range[0], Math.max(v, bounds.min, range[0])])}
      />
      {byValue && <DomainRow path={`${SIZE}.domain`} />}
    </>
  );
}

/** The circles' size as one row: the smallest to the largest circle, opening the Size editor; a size by zoom reads
 * its stops and opens the zoom editor. */
function ClusterSizeRow() {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const { fields } = useStyleData();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const next = useNextLevel();
  useStyleValue("render.symbol");
  const size = getIn(store.document, SIZE) ?? clusterFallback(store.document, "marker.size");
  const label = t("style_editor.size");
  // A size by zoom: its stops, edited in the zoom editor; By count goes back to circles sized by count, over the
  // smallest and largest stop.
  if (isObject(size) && Array.isArray(size.zoom)) {
    const ends = (size.zoom as unknown[]).flatMap((stop) =>
      Array.isArray(stop) && typeof stop[1] === "number" ? [stop[1] as number] : []
    );
    const byCount = () =>
      store.update(
        (doc) =>
          setIn(withClusterSymbol(doc), SIZE, {
            ...DEFAULT_CLUSTER_SYMBOL.marker.size,
            ...(ends.length ? { range: [Math.min(...ends), Math.max(...ends)] } : {}),
          }),
        SIZE
      );
    return (
      <GroupRow
        label={label}
        value={summarize(store.document, SIZE, t, { fields, mapZoom, language: i18n.language })}
        curve
        mode={
          <ValueModeButton
            label={label}
            propertyKey="marker.size"
            mode="zoom"
            modes={["attribute", "zoom"]}
            labels={{ attribute: t("style_editor.cluster_size_by_count") }}
            subs={{ attribute: t("style_editor.cluster_size_by_count_sub") }}
            onSelect={(to) => {
              if (to === "attribute") byCount();
            }}
          />
        }
        onOpen={(anchor) =>
          popover.open(next, {
            key: `zoom:${SIZE}`,
            title: t("style_editor.by_zoom_title", { label, ...PLAIN }),
            anchorTop: anchorTopOf(anchor),
            render: () => <ZoomEditor path={SIZE} />,
          })
        }
      />
    );
  }
  const range = sizeRange(store.document);
  const smallest = plainNumber(range[0], i18n.language);
  const largest = summaryNumber(range[1], "marker.size", i18n.language);
  return (
    <GroupRow
      label={label}
      value={`${smallest} ${t("style_editor.to")} ${largest}`}
      onOpen={(anchor) =>
        popover.open(next, {
          key: "cluster:size",
          title: label,
          anchorTop: anchorTopOf(anchor),
          render: () => <ClusterSizeEditor />,
        })
      }
    />
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
  // Stops waiting for the range of the field picked last: a new pick or the section going away.
  const waiting = useRef<(() => void) | null>(null);
  const stopWaiting = () => {
    waiting.current?.();
    waiting.current = null;
  };
  useEffect(() => stopWaiting, []);
  if (geometry !== "point" || type !== "cluster") return null;
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
      {/* Like the points with the count in the middle, the points' own marker draws: the color is the badge's only. */}
      {!(look === "points" && count === "center") && (
        <ClusterColorRow label={t("style_editor.color")} symbolKey="marker.color" />
      )}
      <ClusterColorRow label={t("style_editor.cluster_number_color")} symbolKey="label.color" />
      {look !== "points" && <ClusterSizeRow />}
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
