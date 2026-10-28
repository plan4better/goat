"use client";

// Legend (prototype 2.8): shown or hidden, its title and what it contains; its editor shows the legend as it will look.
import { useTranslation } from "react-i18next";

import { classifyCount } from "@/lib/style/editor/classify";
import { setIn } from "@/lib/style/editor/store";
import { isObject } from "@/lib/style/json";

import {
  useEditor,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { LegendEditor } from "@/components/map/panels/styleEditor/editors/LegendEditor";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { NavRow, PanelSection, SwitchRow, TextRow } from "@/components/map/panels/styleEditor/rows";

export function LegendSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { layerName } = useStyleData();
  const popover = usePopover();
  const next = useNextLevel();
  const legend = useStyleValue<unknown>("legend");
  const count = useStyleSelector<number>(classifyCount);
  const shown = legend !== false && !(isObject(legend) && legend.show === false);
  const title = isObject(legend) && typeof legend.title === "string" ? legend.title : "";
  const caption = isObject(legend) && typeof legend.caption === "string" ? legend.caption : "";
  const contents = [
    caption ? t("style_editor.caption") : undefined,
    count ? t("style_editor.n_classifications", { count }) : undefined,
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
      <TextRow
        label={t("style_editor.legend_title")}
        value={title}
        placeholder={layerName}
        onChange={(value) => store.set("legend.title", value || undefined)}
      />
      <NavRow
        label={t("style_editor.contents")}
        value={contents.length ? contents.join(" · ") : t("style_editor.none")}
        onOpen={(anchor) =>
          popover.open(next, {
            key: "legend:contents",
            title: t("style_editor.section_legend"),
            anchorTop: anchorTopOf(anchor),
            render: () => <LegendEditor />,
          })
        }
      />
    </PanelSection>
  );
}
