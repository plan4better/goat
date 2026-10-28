"use client";

// Layer for raster files and map services (prototype 3.6, spec 9): opacity, resampling, the image adjustments, the
// cell values drawn transparent, and the zooms. A map service has no cells, so no No data.
import { IconButton, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { fetchRasterPoint } from "@/lib/api/rasters";
import { noDataApplies } from "@/lib/style/editor/raster";
import { type JsonObject, isObject } from "@/lib/style/json";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import {
  useEditor,
  useEditorMap,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import {
  AdjustmentsEditor,
  adjustmentsSummary,
} from "@/components/map/panels/styleEditor/editors/AdjustmentsEditor";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import type { PartRow } from "@/components/map/panels/styleEditor/editors/partRows";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, PanelSection, Row } from "@/components/map/panels/styleEditor/rows";
import { VisibleRow } from "@/components/map/panels/styleEditor/sections/LayerSection";

const OPACITY: PartRow = { type: "number", key: "opacity", label: "style_editor.opacity" };

/** Numbers in a comma or space separated list; null while one does not read as a number yet. */
function parseValues(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const values = parts.map(Number);
  return values.every(Number.isFinite) ? values : null;
}

function NoDataRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const map = useEditorMap();
  const { raster } = useStyleData();
  const noData = useStyleValue<unknown>("render.no_data");
  const band = useStyleValue<unknown>("render.band");
  const values = isObject(noData) && Array.isArray(noData.values) ? (noData.values as number[]) : [];
  const joined = values.join(", ");
  const [draft, setDraft] = useState(joined);
  const [note, setNote] = useState<string | null>(null);
  // An edit elsewhere (undo, a pick) replaces the draft unless the draft already says the same.
  useEffect(() => {
    setDraft((current) => (parseValues(current)?.join(", ") === joined ? current : joined));
  }, [joined]);
  const write = (next: number[]) => store.set("render.no_data", next.length ? { values: next } : undefined);
  const pick = () => {
    if (!map || !raster) return;
    setNote(t("style_editor.no_data_pick_hint"));
    map.once("click", async (event: { lngLat: { lng: number; lat: number } }) => {
      const point = await fetchRasterPoint(raster.dataset, event.lngLat);
      const value = point?.values[(typeof band === "number" ? band : 1) - 1];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        setNote(t("style_editor.no_data_outside"));
        return;
      }
      const current = (store.get("render.no_data.values") as number[] | undefined) ?? [];
      if (!current.includes(value)) write([...current, value]);
      setNote(t("style_editor.no_data_picked", { value }));
    });
  };
  const label = t("style_editor.no_data");
  return (
    <Row
      label={label}
      note={note ?? undefined}
      actions={
        <Tooltip title={t("style_editor.no_data_pick")}>
          <span>
            <IconButton
              size="small"
              aria-label={t("style_editor.no_data_pick")}
              disabled={!map}
              onClick={pick}>
              <Icon iconName={ICON_NAME.LOCATION_CROSSHAIRS} sx={{ fontSize: 14 }} />
            </IconButton>
          </span>
        </Tooltip>
      }>
      <TextFieldInput
        value={draft}
        placeholder={t("style_editor.no_data_placeholder")}
        clearable={false}
        inputProps={{ "aria-label": label }}
        onChange={(text) => {
          setDraft(text);
          const parsed = parseValues(text);
          if (parsed) write(parsed);
        }}
      />
    </Row>
  );
}

function AdjustmentsRow() {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const next = useNextLevel();
  const values = {
    brightness: useStyleValue("brightness"),
    contrast: useStyleValue("contrast"),
    saturation: useStyleValue("saturation"),
    hue: useStyleValue("hue"),
  };
  const label = t("style_editor.adjustments");
  return (
    <NavRow
      label={label}
      value={adjustmentsSummary(values, t) ?? t("style_editor.none")}
      onOpen={(anchor) =>
        popover.open(next, {
          key: "raster:adjustments",
          title: label,
          anchorTop: anchorTopOf(anchor),
          render: () => <AdjustmentsEditor />,
        })
      }
    />
  );
}

export function RasterLayerSection({ service = false }: { service?: boolean }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const type = useStyleValue<unknown>("render.type") ?? "image";
  const resampling = useStyleValue<unknown>("resampling");
  const { raster } = useStyleData();
  const noData = useStyleSelector((doc) =>
    noDataApplies(isObject(doc.render) ? (doc.render as JsonObject) : {}, raster?.info)
  );
  // Categories keep their cells sharp unless the style says otherwise (spec 9).
  const fallback = type === "categorical" ? "nearest" : "linear";
  const current = resampling === "nearest" || resampling === "linear" ? resampling : fallback;
  const label = t("style_editor.resampling");
  return (
    <PanelSection title={t("style_editor.section_layer")}>
      <PropertyRow row={OPACITY} base="" />
      <ChoiceRow<string>
        label={label}
        value={current}
        options={["linear", "nearest"].map((v) => ({
          value: v,
          label: t(`style_editor.resampling_${v}`),
          sub: t(`style_editor.resampling_${v}_sub`),
        }))}
        onChange={(v) => store.set("resampling", v === fallback ? undefined : v)}
      />
      {type === "image" && <AdjustmentsRow />}
      {!service && noData && <NoDataRow />}
      <VisibleRow />
    </PanelSection>
  );
}
