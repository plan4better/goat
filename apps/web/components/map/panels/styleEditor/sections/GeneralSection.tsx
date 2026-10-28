"use client";

// General (points only): how the points are drawn: each as its symbol, as a heatmap, in clusters or as H3 hexagons
// (spec 8).
// Switching writes `render` with its type only; the rest comes from the defaults.
import { useTranslation } from "react-i18next";

import { CLUSTER_FEATURE_LIMIT } from "@/lib/style/editor/parts";
import { choiceLabel } from "@/lib/style/editor/summaries";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { drawAsIcon } from "@/components/map/panels/styleEditor/drawAsIcons";
import { ChoiceRow, PanelSection } from "@/components/map/panels/styleEditor/rows";

const TYPES = ["features", "heatmap", "cluster", "h3"];

export function GeneralSection() {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const { geometry, featureCount } = useStyleData();
  const type = useStyleValue<unknown>("render.type");
  if (geometry !== "point") return null;
  const current = typeof type === "string" ? type : "features";
  const tooMany = featureCount !== undefined && featureCount > CLUSTER_FEATURE_LIMIT;
  const values = TYPES.includes(current) ? TYPES : [...TYPES, current];
  const label = t("style_editor.draw_as");
  return (
    <PanelSection title={t("style_editor.section_general")}>
      <ChoiceRow<string>
        label={label}
        value={current}
        options={values.map((value) => {
          const blocked = value === "cluster" && tooMany && current !== "cluster";
          return {
            value,
            label: choiceLabel(t, "render.type", value),
            icon: drawAsIcon(value),
            sub: blocked
              ? t("style_editor.clusters_too_many", { features: featureCount?.toLocaleString(i18n.language) })
              : t(`style_editor.value_render_type_${value}_sub`, { defaultValue: "" }) || undefined,
            disabled: blocked,
          };
        })}
        onChange={(value) => store.set("render", value === "features" ? undefined : { type: value })}
      />
    </PanelSection>
  );
}
