"use client";

// Layer (prototype 2.7): opacity, the zooms the layer shows at, which features draw on top, the position among the
// basemap's layers (map state, where there is a map document) and a time field. The filter and the time slider's value
// belong to the map document.
import { Link, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { classifyCount } from "@/lib/style/editor/classify";
import { symbolShown } from "@/lib/style/editor/parts";
import { recordPaths } from "@/lib/style/editor/sources";
import { isObject } from "@/lib/style/json";

import {
  useEditor,
  useScope,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import { VisibleEditor } from "@/components/map/panels/styleEditor/editors/VisibleEditor";
import { type PartRow, partLabelKey } from "@/components/map/panels/styleEditor/editors/partRows";
import {
  type Position,
  dropOffer,
  placementKey,
  useLayerMapState,
  useMoveOffered,
} from "@/components/map/panels/styleEditor/mapState";
import { PLAIN } from "@/components/map/panels/styleEditor/plainText";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, PanelSection } from "@/components/map/panels/styleEditor/rows";

const OPACITY: PartRow = { type: "number", key: "opacity", label: "style_editor.opacity" };
const DATE_STEPS = ["year", "month", "day"];

/** "All zooms", "From zoom 8", "Up to zoom 14", "Zoom 8 to 14". */
export function zoomText(t: TFunction, from: unknown, until: unknown): string {
  const a = typeof from === "number" ? from : undefined;
  const b = typeof until === "number" ? until : undefined;
  if (a === undefined && b === undefined) return t("style_editor.all_zooms");
  if (b === undefined) return t("style_editor.from_zoom", { zoom: a });
  if (a === undefined) return t("style_editor.up_to_zoom", { zoom: b });
  return t("style_editor.zoom_range", { from: a, until: b });
}

export function VisibleRow() {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const next = useNextLevel();
  const from = useStyleValue<unknown>("min_zoom");
  const until = useStyleValue<unknown>("max_zoom");
  const symbol = useStyleValue<unknown>("symbol");
  const { geometry } = useStyleData();
  // Parts that show at fewer zooms than the layer, named as the symbol section names them: "Marker: From zoom 12".
  const parts = isObject(symbol)
    ? Object.entries(symbol).flatMap(([part, value]) =>
        isObject(value) && (value.min_zoom !== undefined || value.max_zoom !== undefined)
          ? [
              t("style_editor.part_zooms", {
                part: t(partLabelKey(part, geometry, value)),
                zooms: zoomText(t, value.min_zoom, value.max_zoom),
                ...PLAIN,
              }),
            ]
          : []
      )
    : [];
  // Classes and rules that show their features, or a part of them, at other zooms (spec 3.5).
  const varies = useStyleSelector((doc) =>
    recordPaths(doc).some(({ record }) =>
      [record, ...Object.values(record).filter(isObject)].some(
        (node) => node.min_zoom !== undefined || node.max_zoom !== undefined
      )
    )
  );
  const label = t("style_editor.visible");
  return (
    <NavRow
      label={label}
      value={[zoomText(t, from, until), ...parts, ...(varies ? [t("style_editor.zooms_vary")] : [])].join(
        " · "
      )}
      onOpen={(anchor) =>
        popover.open(next, {
          key: "layer:visible",
          title: label,
          anchorTop: anchorTopOf(anchor),
          render: () => <VisibleEditor />,
        })
      }
    />
  );
}

function DrawOrderRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields } = useStyleData();
  const order = useStyleValue<unknown>("order");
  const hasClasses = useStyleSelector((doc) => classifyCount(doc) > 0);
  const current = !isObject(order)
    ? ""
    : order.by === "classes"
      ? "classes"
      : `${String(order.top)}:${String(order.field)}`;
  const label = t("style_editor.draw_order");
  return (
    <ChoiceRow<string>
      label={label}
      value={current}
      options={[
        { value: "", label: t("style_editor.order_data") },
        ...(hasClasses || current === "classes"
          ? [{ value: "classes", label: t("style_editor.order_classes") }]
          : []),
        ...fields
          .filter((f) => f.type === "number" || f.type === "integer")
          .flatMap((f) => [
            {
              value: `smallest:${f.name}`,
              label: t("style_editor.order_smallest", { field: f.label, ...PLAIN }),
            },
            {
              value: `largest:${f.name}`,
              label: t("style_editor.order_largest", { field: f.label, ...PLAIN }),
            },
          ]),
      ]}
      onChange={(value) => {
        const at = value.indexOf(":");
        store.set(
          "order",
          value === ""
            ? undefined
            : value === "classes"
              ? { by: "classes" }
              : { field: value.slice(at + 1), top: value.slice(0, at) }
        );
      }}
    />
  );
}

function TimeRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields } = useStyleData();
  const time = useStyleValue<unknown>("time");
  const current = isObject(time) ? `${String(time.field)}\u0000${String(time.step)}` : "";
  const options = [
    { value: "", label: t("style_editor.time_off") },
    ...fields.flatMap((f) =>
      f.type === "integer"
        ? [{ value: `${f.name}\u00001`, label: t("style_editor.time_one", { field: f.label, ...PLAIN }) }]
        : f.type === "date" || f.type === "datetime"
          ? DATE_STEPS.map((step) => ({
              value: `${f.name}\u0000${step}`,
              label: t("style_editor.time_date", {
                field: f.label,
                step: t(`style_editor.time_step_${step}`),
                ...PLAIN,
              }),
            }))
          : []
    ),
  ];
  const label = t("style_editor.time");
  return (
    <ChoiceRow<string>
      label={label}
      value={current}
      options={options}
      onChange={(value) => {
        if (!value) return store.set("time", undefined);
        const [field, step] = value.split("\u0000");
        store.set("time", { field, step: step === "1" ? 1 : step });
      }}
    />
  );
}

const POSITIONS: Position[] = ["top", "below_labels", "below_roads"];

/** "The colors hide the basemap's place names. Move below labels", the Position row's note after Draw as turned an
 * image on top into colors of its own: the move as a text link. */
function MoveBelowLabels({ onMove }: { onMove: () => void }) {
  const { t } = useTranslation("common");
  return (
    <>
      {t("style_editor.position_hides_labels")}{" "}
      <Link
        component="button"
        type="button"
        variant="caption"
        underline="hover"
        onClick={onMove}
        sx={{ verticalAlign: "baseline", textAlign: "left" }}>
        {t("style_editor.position_move_below_labels")}
      </Link>
    </>
  );
}

/** Where the layer draws among the basemap's layers (map state, not style); vector and raster layers alike. */
export function PositionRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const mapState = useLayerMapState();
  const type = useStyleValue<unknown>("render.type");
  const key = mapState ? placementKey(mapState, store) : undefined;
  const offered = useMoveOffered(key, store);
  // The offer shows in the named style it was made in, while the layer is on top and draws colors of its own there:
  // an image again (an undo) or another place ends it, so neither a redo nor a way back on top brings the note back.
  const stands = mapState?.position === "top" && typeof type === "string" && type !== "image";
  useEffect(() => {
    if (offered && !stands) dropOffer(key);
  }, [offered, stands, key]);
  if (!mapState) return null;
  const label = t("position");
  return (
    <ChoiceRow<Position>
      label={label}
      value={mapState.position}
      options={POSITIONS.map((value) => ({ value, label: t(`style_editor.position_${value}`) }))}
      note={
        offered && stands ? (
          <MoveBelowLabels
            onMove={() => {
              dropOffer(key);
              mapState.onPosition("below_labels");
            }}
          />
        ) : undefined
      }
      onChange={(next) => {
        dropOffer(key);
        mapState.onPosition(next);
      }}
    />
  );
}

export function LayerSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const scope = useScope();
  useStyleValue("render");
  return (
    <PanelSection
      title={t("style_editor.section_layer")}
      // While a class or a rule is scoped the symbol's rows edit it alone; these stay the layer's.
      scopeNote={
        scope ? (
          <Typography variant="caption" color="text.secondary">
            {t("style_editor.section_layer_scope_note")}
          </Typography>
        ) : undefined
      }>
      <PropertyRow row={OPACITY} base="" />
      <VisibleRow />
      {symbolShown(store.document) && <DrawOrderRow />}
      <PositionRow />
      <TimeRow />
    </PanelSection>
  );
}
