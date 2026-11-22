"use client";

// Legend (prototype 2.8): shown or hidden, its entries or the layer's name only, its title and what it contains; its
// editor shows the legend as it will look.
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { classifyCount } from "@/lib/style/editor/classify";
import { formatNumberText } from "@/lib/style/editor/labels";
import { setIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";
import { rasterColorSpec } from "@/lib/style/raster/color";

import {
  useEditor,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { LegendEditor, setLegendKey } from "@/components/map/panels/styleEditor/editors/LegendEditor";
import { ResetToDataset } from "@/components/map/panels/styleEditor/popovers/ResetToDataset";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  NavRow,
  PanelSection,
  SwitchRow,
  TextRow,
} from "@/components/map/panels/styleEditor/rows";

/** What a raster's legend shows for a ramp (a palette over a range, or own colors at values) as the legend writes its
 * ends: "Color ramp, 32 to 119 m", an end label in place of its number; undefined for anything else. */
function rampSummary(render: unknown, legend: JsonObject, t: TFunction, locale: string): string | undefined {
  const spec = rasterColorSpec(isObject(render) ? render : {});
  if (spec?.kind !== "ramp" && spec?.kind !== "stops") return undefined;
  const ends: [number, number] | null =
    spec.kind === "ramp" ? spec.domain : [spec.stops[0].value, spec.stops[spec.stops.length - 1].value];
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const labels = [text(legend.min_label), text(legend.max_label)];
  const unit = text(legend.unit);
  const word = t("style_editor.legend_ramp");
  const number = (i: 0 | 1) => (ends ? formatNumberText(ends[i], {}, locale) : undefined);
  const to = t("style_editor.to");
  if (!labels.some(Boolean)) {
    if (!ends) return word;
    return `${word}, ${number(0)} ${to} ${number(1)}${unit ? ` ${unit}` : ""}`;
  }
  // As the legend: each end its label, else its number with the unit.
  const end = (i: 0 | 1) => labels[i] ?? (ends ? `${number(i)}${unit ? ` ${unit}` : ""}` : undefined);
  const [from, until] = [end(0), end(1)];
  return from && until ? `${word}, ${from} ${to} ${until}` : word;
}

export function LegendSection() {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const { layerName } = useStyleData();
  const popover = usePopover();
  const next = useNextLevel();
  const legend = useStyleValue<unknown>("legend");
  const count = useStyleSelector<number>(classifyCount);
  const raster = useStyleValue<unknown>("kind") === "raster";
  const render = useStyleValue<unknown>("render");
  const shown = legend !== false && !(isObject(legend) && legend.show === false);
  const title = isObject(legend) && typeof legend.title === "string" ? legend.title : "";
  const caption = isObject(legend) && typeof legend.caption === "string" ? legend.caption : "";
  const contents = [
    caption ? t("style_editor.caption") : undefined,
    // A raster's colors are one classification: its classes say more; a ramp says what its ends read.
    count
      ? t(raster ? "style_editor.count_classes" : "style_editor.n_classifications", { count })
      : raster
        ? rampSummary(render, isObject(legend) ? legend : {}, t, i18n.language)
        : undefined,
  ].filter(Boolean);
  return (
    <PanelSection title={t("style_editor.section_legend")}>
      <SwitchRow
        label={t("style_editor.show")}
        on={shown}
        valueText={t(shown ? "style_editor.legend_shown" : "style_editor.legend_hidden")}
        onToggle={() =>
          store.update((doc) => {
            const base = { ...(isObject(legend) ? legend : {}) };
            if (shown) base.show = false;
            else delete base.show;
            return setIn(doc, "legend", Object.keys(base).length ? base : undefined);
          }, "legend.show")
        }
      />
      {/* The entries, or the layer's name alone (a hillshade, an aerial photo, a long category list). */}
      <ChoiceRow<string>
        label={t("style_editor.legend_display")}
        value={isObject(legend) && legend.display === "name_only" ? "name_only" : "standard"}
        options={["standard", "name_only"].map((v) => ({
          value: v,
          label: t(`style_editor.legend_display_${v}`),
          sub: t(`style_editor.legend_display_${v}_sub`),
        }))}
        onChange={(v) => setLegendKey(store, "display", v === "name_only" ? v : undefined)}
      />
      <TextRow
        label={t("style_editor.legend_title")}
        value={title}
        placeholder={layerName}
        onChange={(value) => setLegendKey(store, "title", value || undefined)}
      />
      <NavRow
        label={t("style_editor.contents")}
        value={contents.length ? contents.join(" · ") : t("style_editor.none")}
        onOpen={(anchor) =>
          popover.open(next, {
            key: "legend:contents",
            title: t("style_editor.section_legend"),
            anchorTop: anchorTopOf(anchor),
            actions: <ResetToDataset paths={["legend"]} />,
            render: () => <LegendEditor />,
          })
        }
      />
    </PanelSection>
  );
}
