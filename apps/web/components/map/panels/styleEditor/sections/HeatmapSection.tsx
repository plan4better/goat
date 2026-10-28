"use client";

// Heatmap (spec 8.1): the colors of the density ramp, radius and intensity (fixed or by zoom), the weight of each
// point, and the zoom from which the points themselves show.
import { Box } from "@mui/material";
import { useTranslation } from "react-i18next";

import { setIn } from "@/lib/style/editor/store";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { isObject } from "@/lib/style/json";

import {
  type FieldProfile,
  useEditor,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import type { PartRow } from "@/components/map/panels/styleEditor/editors/partRows";
import { PalettePicker, paletteColors } from "@/components/map/panels/styleEditor/pickers/PalettePicker";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, NumberInput, PanelSection, Row } from "@/components/map/panels/styleEditor/rows";

const RADIUS: PartRow = { type: "number", key: "radius", label: "style_editor.radius" };
const INTENSITY: PartRow = { type: "number", key: "intensity", label: "style_editor.intensity" };
const OPACITY: PartRow = { type: "number", key: "opacity", label: "style_editor.opacity" };
const POINT_ZOOMS = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const NEVER = "never";

type Palette = string | string[];

type PaletteKind = "sequential" | "diverging";

interface RenderPaletteProps {
  fallback: string;
  kinds?: PaletteKind[];
  onPick?: () => void;
}

function RenderPalettePicker({ fallback, kinds = ["sequential"], onPick }: RenderPaletteProps) {
  const store = useEditor();
  const palette = useStyleValue<Palette | undefined>("render.palette");
  const reverse = useStyleValue<boolean | undefined>("render.reverse");
  return (
    <PalettePicker
      value={palette ?? fallback}
      reverse={reverse === true}
      kinds={kinds}
      onChange={(next) => {
        store.set("render.palette", next);
        onPick?.();
      }}
      onReverse={(next) => store.set("render.reverse", next || undefined)}
    />
  );
}

/** The colors of a render (`render.palette`, `render.reverse`): the heatmap's density ramp, H3's cell values.
 * `onPick` runs after a palette is picked. */
export function RenderPaletteRow({ fallback, kinds, onPick }: RenderPaletteProps) {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const value = useStyleValue<Palette | undefined>("render.palette") ?? fallback;
  const reverse = useStyleValue<boolean | undefined>("render.reverse");
  const colors = paletteColors(value);
  if (reverse) colors.reverse();
  const label = t("style_editor.colors");
  return (
    <NavRow
      label={label}
      value={Array.isArray(value) ? t("style_editor.palette_custom") : (PALETTES[value]?.name ?? value)}
      swatch={{ background: `linear-gradient(90deg, ${colors.join(", ")})`, wide: true }}
      onOpen={(anchor) =>
        popover.open("picker", {
          key: "render:palette",
          title: label,
          anchorTop: anchorTopOf(anchor),
          anchorEl: anchor,
          render: () => <RenderPalettePicker fallback={fallback} kinds={kinds} onPick={onPick} />,
        })
      }
    />
  );
}

function WeightRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields, profiles } = useStyleData();
  const weight = useStyleValue<unknown>("render.weight");
  const current =
    typeof weight === "object" && weight !== null && "field" in weight ? String(weight.field) : "";
  const numbers = fields.filter((f) => f.type === "number" || f.type === "integer");
  const label = t("style_editor.weight");
  return (
    <ChoiceRow<string>
      label={label}
      value={current}
      options={[
        { value: "", label: t("style_editor.weight_once") },
        ...numbers.map((f) => ({ value: f.name, label: t("style_editor.by_field", { field: f.label }) })),
      ]}
      onChange={(field) => {
        // A weight by a field needs its range (spec 8.1): the field's lowest and highest value. It is part of the
        // pick: written with it, or once when the profile arrives; never again, so undo can go back past it.
        const rangeOf = (profile: FieldProfile | undefined) =>
          profile?.min !== undefined && profile.max !== undefined ? [profile.min, profile.max] : undefined;
        const domain = rangeOf(profiles.get(field));
        store.set("render.weight", field ? { field, ...(domain ? { domain } : {}) } : undefined);
        if (!field || domain) return;
        const stop = profiles.subscribe(() => {
          const range = rangeOf(profiles.get(field));
          if (!range) return;
          stop();
          const now = store.get("render.weight");
          if (isObject(now) && now.field === field && now.domain === undefined)
            store.update((doc) => setIn(doc, "render.weight.domain", range), "render.weight");
        });
        profiles.load(field);
      }}
    />
  );
}

/** The weight's range: written with the field's pick, then typed. */
function WeightRange() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const weight = useStyleValue<unknown>("render.weight");
  const field = isObject(weight) && typeof weight.field === "string" ? weight.field : undefined;
  const domain =
    isObject(weight) && Array.isArray(weight.domain) ? (weight.domain as [number, number]) : undefined;
  if (!field) return null;
  return (
    <Row label={t("style_editor.range")}>
      <Box sx={{ display: "flex", gap: 2, flex: 1, minWidth: 0 }}>
        <NumberInput
          value={domain?.[0]}
          ariaLabel={t("style_editor.range_lowest")}
          onChange={(v) =>
            store.update(
              (doc) => setIn(doc, "render.weight.domain", [v, domain?.[1] ?? v]),
              "render.weight.domain"
            )
          }
        />
        <NumberInput
          value={domain?.[1]}
          ariaLabel={t("style_editor.range_highest")}
          onChange={(v) =>
            store.update(
              (doc) => setIn(doc, "render.weight.domain", [domain?.[0] ?? v, v]),
              "render.weight.domain"
            )
          }
        />
      </Box>
    </Row>
  );
}

/** From which zoom the points themselves draw instead of the render; `never` names what draws instead. */
export function PointsRow({ never }: { never: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const zoom = useStyleValue<unknown>("render.points_from_zoom");
  const label = t("style_editor.points");
  return (
    <ChoiceRow<string>
      label={label}
      value={typeof zoom === "number" ? String(zoom) : NEVER}
      options={[
        { value: NEVER, label: never },
        ...POINT_ZOOMS.map((z) => ({
          value: String(z),
          label: t("style_editor.points_from_zoom", { zoom: z }),
        })),
      ]}
      onChange={(value) => store.set("render.points_from_zoom", value === NEVER ? undefined : Number(value))}
    />
  );
}

export function HeatmapSection() {
  const { t } = useTranslation("common");
  const { geometry } = useStyleData();
  const type = useStyleValue<unknown>("render.type");
  if (geometry !== "point" || type !== "heatmap") return null;
  return (
    <PanelSection title={t("style_editor.section_heatmap")}>
      <RenderPaletteRow fallback={DEFAULTS["heatmap.palette"] as string} />
      <PropertyRow row={RADIUS} base="render" />
      <PropertyRow row={INTENSITY} base="render" />
      <PropertyRow row={OPACITY} base="render" />
      <WeightRow />
      <WeightRange />
      <PointsRow never={t("style_editor.points_never")} />
    </PanelSection>
  );
}
