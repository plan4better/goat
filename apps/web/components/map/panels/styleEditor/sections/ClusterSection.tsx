"use client";

// Clusters (spec 8.2): the cluster circle and count colors, the merge radius, the zoom from which single points
// show, and the fewest points a cluster takes. Editing a cluster color writes out the default cluster symbol first,
// so the circles keep their size by count and their count label.
import { useTranslation } from "react-i18next";

import { SLIDERS } from "@/lib/style/editor/defaults";
import { clusterFallback, withClusterSymbol } from "@/lib/style/editor/parts";
import { type Path, setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { ChoiceRow, PanelSection, SliderRow } from "@/components/map/panels/styleEditor/rows";

const UNTIL_ZOOMS = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const MIN_POINTS = [2, 3, 5, 10];

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

export function ClusterSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const type = useStyleValue<unknown>("render.type");
  const radius = useStyleValue<unknown>("render.radius");
  const until = useStyleValue<unknown>("render.cluster_until_zoom");
  const minPoints = useStyleValue<unknown>("render.min_points");
  if (geometry !== "point" || type !== "cluster") return null;
  const range = SLIDERS["cluster.radius"];
  const number = (value: unknown, key: string) =>
    typeof value === "number" ? value : (DEFAULTS[key] as number);
  return (
    <PanelSection title={t("style_editor.section_clusters")}>
      <ClusterColorRow label={t("style_editor.color")} symbolKey="marker.color" />
      <ClusterColorRow label={t("style_editor.count")} symbolKey="label.color" />
      <SliderRow
        label={t("style_editor.radius")}
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
        options={UNTIL_ZOOMS.map((z) => ({ value: String(z), label: t("style_editor.zoom_n", { zoom: z }) }))}
        onChange={(value) => store.set("render.cluster_until_zoom", Number(value))}
      />
      <ChoiceRow<string>
        label={t("style_editor.smallest")}
        value={String(number(minPoints, "cluster.min_points"))}
        options={MIN_POINTS.map((n) => ({
          value: String(n),
          label: t("style_editor.n_points", { count: n }),
        }))}
        onChange={(value) => store.set("render.min_points", Number(value))}
      />
    </PanelSection>
  );
}
