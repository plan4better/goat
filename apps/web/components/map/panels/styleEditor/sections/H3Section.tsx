"use client";

// H3 hexagons (spec 8.3): the hexagon size, what a hexagon's value is (its points, or a field's sum or mean), the
// colors as classes or continuous, opacity and outline, and the zoom from which the points themselves show. The
// server computes the classes per resolution when the style is saved.
import { Box } from "@mui/material";
import { useTranslation } from "react-i18next";

import { SLIDERS } from "@/lib/style/editor/defaults";
import { setIn } from "@/lib/style/editor/store";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { isObject } from "@/lib/style/json";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  ColorField,
  NumberInput,
  PanelSection,
  Row,
  SliderRow,
} from "@/components/map/panels/styleEditor/rows";
import { PointsRow, RenderPaletteRow } from "@/components/map/panels/styleEditor/sections/HeatmapSection";

const AUTO = "auto";
/** About how wide a hexagon of each resolution is, in meters (twice H3's average edge length). */
const WIDTH_M: Record<number, number> = { 5: 19700, 6: 7400, 7: 2800, 8: 1100, 9: 400, 10: 150 };
const METHODS = ["quantile", "equal_interval", "natural_breaks", "std_dev", "heads_and_tails"];
const CONTINUOUS = "continuous";
const COUNTS = [3, 4, 5, 6, 7, 8, 9];
/** Classes a method makes when the classification gives no count (goatlib DEFAULT_COUNT). */
const DEFAULTS_COUNT = 5;
const COUNT = "count";

function SizeRow() {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const resolution = useStyleValue<unknown>("render.resolution");
  const width = (m: number) =>
    m >= 1000
      ? `${(m / 1000).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} km`
      : `${m.toLocaleString(i18n.language)} m`;
  return (
    <ChoiceRow<string>
      label={t("style_editor.h3_size")}
      value={typeof resolution === "number" ? String(resolution) : AUTO}
      options={[
        { value: AUTO, label: t("style_editor.h3_size_auto"), sub: t("style_editor.h3_size_auto_sub") },
        ...Object.entries(WIDTH_M).map(([res, m]) => ({
          value: res,
          label: t("style_editor.h3_resolution", { resolution: res }),
          sub: t("style_editor.h3_width", { width: width(m) }),
        })),
      ]}
      onChange={(value) => store.set("render.resolution", value === AUTO ? undefined : Number(value))}
    />
  );
}

function ValueRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields } = useStyleData();
  const value = useStyleValue<unknown>("render.value");
  const current =
    isObject(value) && value.op !== COUNT && typeof value.field === "string"
      ? `${value.op}:${value.field}`
      : COUNT;
  const numbers = fields.filter((f) => f.type === "number" || f.type === "integer");
  return (
    <ChoiceRow<string>
      label={t("style_editor.h3_value")}
      value={current}
      options={[
        { value: COUNT, label: t("style_editor.h3_value_count") },
        ...numbers.flatMap((f) => [
          { value: `sum:${f.name}`, label: t("style_editor.h3_value_sum", { field: f.label }) },
          { value: `mean:${f.name}`, label: t("style_editor.h3_value_mean", { field: f.label }) },
        ]),
      ]}
      onChange={(next) => {
        if (next === COUNT) return store.set("render.value", undefined);
        const [op, ...field] = next.split(":");
        store.set("render.value", { op, field: field.join(":") });
      }}
    />
  );
}

function ClassesRows() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const classify = useStyleValue<unknown>("render.classify");
  const method = isObject(classify) && typeof classify.method === "string" ? classify.method : CONTINUOUS;
  const count = isObject(classify) && typeof classify.count === "number" ? classify.count : DEFAULTS_COUNT;
  const methods = METHODS.includes(method) || method === CONTINUOUS ? METHODS : [...METHODS, method];
  return (
    <>
      <ChoiceRow<string>
        label={t("style_editor.classes")}
        value={method}
        options={[
          {
            value: CONTINUOUS,
            label: t("style_editor.h3_continuous"),
            sub: t("style_editor.h3_continuous_sub"),
          },
          ...methods.map((m) => ({
            value: m,
            label: t(`style_editor.method_${m}`),
            sub: t(`style_editor.method_${m}_sub`, { defaultValue: "" }) || undefined,
          })),
        ]}
        onChange={(next) =>
          store.set(
            "render.classify",
            next === CONTINUOUS
              ? undefined
              : { method: next, count: isObject(classify) ? count : DEFAULTS_COUNT }
          )
        }
      />
      {method !== CONTINUOUS && method !== "manual" && (
        <ChoiceRow<string>
          label={t("style_editor.count")}
          value={String(count)}
          options={COUNTS.map((n) => ({
            value: String(n),
            label: t("style_editor.count_classes", { count: n }),
          }))}
          onChange={(next) =>
            store.update((doc) => setIn(doc, "render.classify.count", Number(next)), "render.classify.count")
          }
        />
      )}
    </>
  );
}

function OutlineRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const color = useStyleValue<unknown>("render.outline.color");
  const width = useStyleValue<unknown>("render.outline.width");
  const fallback = DEFAULTS["h3.outline.color"] as string;
  const label = t("style_editor.part_outline");
  return (
    <Row label={label}>
      <Box sx={{ display: "flex", gap: 2, flex: 1, minWidth: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ColorField
            value={typeof color === "string" ? color : fallback}
            onOpenPicker={(anchor) =>
              popover.open("picker", {
                key: "h3:outline",
                title: label,
                anchorTop: anchorTopOf(anchor),
                anchorEl: anchor,
                render: () => (
                  <PathColorPicker
                    path="render.outline.color"
                    fallback={fallback}
                    write={(next) => store.set("render.outline.color", next)}
                  />
                ),
              })
            }
          />
        </Box>
        <NumberInput
          value={typeof width === "number" ? width : (DEFAULTS["h3.outline.width"] as number)}
          unit="px"
          min={0}
          ariaLabel={t("style_editor.width")}
          onChange={(next) => store.set("render.outline.width", next)}
        />
      </Box>
    </Row>
  );
}

export function H3Section() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const type = useStyleValue<unknown>("render.type");
  const opacity = useStyleValue<unknown>("render.opacity");
  if (geometry !== "point" || type !== "h3") return null;
  const range = SLIDERS["h3.opacity"];
  return (
    <PanelSection title={t("style_editor.section_h3")}>
      <SizeRow />
      <ValueRow />
      <RenderPaletteRow
        fallback={DEFAULTS["h3.palette"] as string}
        kinds={["sequential", "diverging"]}
        // The render's palette colors the classes too: a palette of their own would hide the pick.
        onPick={() => {
          if (isObject(store.get("render.classify")) && store.get("render.classify.palette") !== undefined)
            store.update(
              (doc) => setIn(doc, "render.classify.palette", undefined),
              "render.classify.palette"
            );
        }}
      />
      <ClassesRows />
      <SliderRow
        label={t("style_editor.opacity")}
        min={range.min}
        max={range.max}
        step={range.step}
        pct={range.pct}
        value={typeof opacity === "number" ? opacity : (DEFAULTS["h3.opacity"] as number)}
        onChange={(next) => store.set("render.opacity", next)}
      />
      <OutlineRow />
      <PointsRow never={t("style_editor.points_never_h3")} />
    </PanelSection>
  );
}
