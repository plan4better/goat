"use client";

// Heatmap (spec 8.1): the colors of the density ramp, radius and intensity (fixed or by zoom), the weight of each
// point, and the zoom from which the points themselves show (a row that opens its switch and slider).
import { Box, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { paletteList } from "@/lib/style/editor/paletteList";
import { type Path, setIn } from "@/lib/style/editor/store";
import { PALETTES } from "@/lib/style/generated/catalog";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { isObject } from "@/lib/style/json";

import {
  type FieldProfile,
  useEditor,
  useLiveMapZoom,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { useRangeBoxes } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import { PaletteColors, type PaletteSource } from "@/components/map/panels/styleEditor/editors/PaletteColors";
import { HeaderSwitch, togglePart } from "@/components/map/panels/styleEditor/editors/PartEditor";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import type { PartRow } from "@/components/map/panels/styleEditor/editors/partRows";
import { PalettePicker, paletteColors } from "@/components/map/panels/styleEditor/pickers/PalettePicker";
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
  NavRow,
  NumberInput,
  PanelSection,
  Row,
  ZoomRangeRow,
} from "@/components/map/panels/styleEditor/rows";

const RADIUS: PartRow = { type: "number", key: "radius", label: "style_editor.radius" };
const INTENSITY: PartRow = { type: "number", key: "intensity", label: "style_editor.intensity" };
const OPACITY: PartRow = { type: "number", key: "opacity", label: "style_editor.opacity" };
/** The zoom the points show from when their switch turns them on with nothing to bring back. */
const POINTS_START = 10;
const POINTS: Path = "render.points_from_zoom";

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

/** A continuous render's palette as its list edits it. An edit is a palette picked (`onPick` runs after it). */
function useRenderPalette({
  fallback,
  onPick,
}: Pick<RenderPaletteProps, "fallback" | "onPick">): PaletteSource {
  const store = useEditor();
  const value = useStyleValue<Palette | undefined>("render.palette") ?? fallback;
  const reverse = useStyleValue<boolean | undefined>("render.reverse");
  // H3 cell values have a range (written or computed): the rows name where their colors sit; a heatmap's density has
  // none, its rows name their colors.
  const domain = useStyleValue<unknown>("render.domain");
  const computed = useStyleValue<unknown>("render.computed.domain");
  const range = [domain, computed].find(
    (d): d is [number, number] => Array.isArray(d) && d.length === 2 && d.every((v) => typeof v === "number")
  );
  return {
    colors: paletteList(value, { reverse: reverse === true }),
    ...(range ? { valueAt: (t: number) => range[0] + t * (range[1] - range[0]) } : {}),
    write: (colors) => {
      store.update(
        (doc) => setIn(setIn(doc, "render.palette", colors), "render.reverse", undefined),
        "render.palette"
      );
      onPick?.();
    },
  };
}

/** The colors of a render as the Colors row and the Palette row show them: the palette's name ("Custom" for a list of
 * its own) and its ramp, in the order the map draws them. */
function useRampView(fallback: string) {
  const { t } = useTranslation("common");
  const value = useStyleValue<Palette | undefined>("render.palette") ?? fallback;
  const reverse = useStyleValue<boolean | undefined>("render.reverse");
  // A copy: an inline palette is the stored list itself.
  const colors = [...paletteColors(value)];
  if (reverse) colors.reverse();
  return {
    name: Array.isArray(value) ? t("style_editor.palette_custom") : (PALETTES[value]?.name ?? value),
    reverse: reverse === true,
    swatch: { background: `linear-gradient(90deg, ${colors.join(", ")})`, wide: true },
  };
}

interface RenderColorsProps extends RenderPaletteProps {
  /** Rows between the Palette and the colors' list (H3's Classes). */
  classes?: ReactNode;
}

/** The Colors editor of a render of `type`, built as a color by attribute's: the Palette (opening the palette picker),
 * `classes`, and a continuous ramp's colors as a list to edit at the bottom (classes take their colors from the
 * palette). It closes once the render is another one. */
function RenderColorsEditor({
  fallback,
  kinds,
  onPick,
  classes,
  type,
}: RenderColorsProps & { type: unknown }) {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const renderType = useStyleValue<unknown>("render.type");
  const classified = isObject(useStyleValue<unknown>("render.classify"));
  const ramp = useRampView(fallback);
  useCloseWhenGone(renderType !== type);
  return (
    <>
      <NavRow
        label={t("style_editor.palette")}
        value={`${ramp.name}${ramp.reverse ? `, ${t("style_editor.reversed")}` : ""}`}
        swatch={ramp.swatch}
        onOpen={(anchor) =>
          popover.open("picker", {
            key: "render:palette",
            title: t("style_editor.palette"),
            anchorTop: anchorTopOf(anchor),
            anchorEl: anchor,
            render: () => <RenderPalettePicker fallback={fallback} kinds={kinds} onPick={onPick} />,
          })
        }
      />
      {classes}
      {!classified && (
        <PaletteColors useSource={useRenderPalette} args={{ fallback, onPick }} pickerKey="render:palette" />
      )}
    </>
  );
}

/** The colors of a render (`render.palette`, `render.reverse`): the heatmap's density ramp, H3's cell values, as one
 * row with the ramp and the palette's name that opens their editor (`RenderColorsEditor`). `onPick` runs after a
 * palette is picked. */
export function RenderPaletteRow({ fallback, kinds, onPick, classes }: RenderColorsProps) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const next = useNextLevel();
  const ramp = useRampView(fallback);
  const label = t("style_editor.colors");
  return (
    <NavRow
      label={label}
      value={ramp.name}
      swatch={ramp.swatch}
      onOpen={(anchor) => {
        const type = store.get("render.type");
        popover.open(next, {
          key: "render:colors",
          title: label,
          anchorTop: anchorTopOf(anchor),
          render: () => (
            <RenderColorsEditor
              fallback={fallback}
              kinds={kinds}
              onPick={onPick}
              classes={classes}
              type={type}
            />
          ),
        });
      }}
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
        ...numbers.map((f) => ({
          value: f.name,
          label: t("style_editor.by_field", { field: f.label, ...PLAIN }),
        })),
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
  const weight = useStyleValue<unknown>("render.weight");
  if (!(isObject(weight) && typeof weight.field === "string")) return null;
  return <DomainRow path="render.weight.domain" />;
}

/** A value's range as its lowest and highest number, typed (a weight's, a cluster value's); written once both boxes
 * have a number, from low to high. */
export function DomainRow({ path }: { path: Path }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const value = useStyleValue<unknown>(path);
  const domain = Array.isArray(value) ? (value as [number, number]) : undefined;
  const boxes = useRangeBoxes(domain, (next) => store.update((doc) => setIn(doc, path, next), path));
  return (
    <Row
      label={t("style_editor.range")}
      note={boxes.invalid ? t("style_editor.range_low_to_high") : undefined}>
      <Box sx={{ display: "flex", gap: 2, flex: 1, minWidth: 0 }}>
        <NumberInput
          value={boxes.shown[0]}
          ariaLabel={t("style_editor.range_lowest")}
          commitOnLeave
          onChange={(v) => boxes.commit(0, v)}
        />
        <NumberInput
          value={boxes.shown[1]}
          ariaLabel={t("style_editor.range_highest")}
          commitOnLeave
          onChange={(v) => boxes.commit(1, v)}
        />
      </Box>
    </Row>
  );
}

/** The points' switch, for their editor's header: on brings back the zoom it switched off, else zoom 10;
 * off removes `render.points_from_zoom`: the points never show. */
function PointsSwitch() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const on = typeof useStyleValue<unknown>(POINTS) === "number";
  return (
    <HeaderSwitch
      name={t("style_editor.part_name_points")}
      on={on}
      onToggle={() => togglePart(store, POINTS, !on, undefined, POINTS_START, { offAbsent: true })}
    />
  );
}

/** The points' editor: while on, the zoom from which they show on the zoom slider, the map's zoom marked, and `note`
 * on what the map shows on either side. It closes once the layer draws as another render than `type`. */
function PointsEditor({ type, note }: { type: unknown; note: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const renderType = useStyleValue<unknown>("render.type");
  const zoom = useStyleValue<unknown>(POINTS);
  const mapZoom = useLiveMapZoom();
  useCloseWhenGone(geometry !== "point" || renderType !== type);
  if (typeof zoom !== "number")
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 2 }}>
        {t("style_editor.part_off_note")}
      </Typography>
    );
  return (
    <>
      <ZoomRangeRow
        label={t("style_editor.zoom_from")}
        value={zoom}
        mapZoom={mapZoom}
        // Its own undo step, apart from the switch's.
        onValue={(next) => store.update((doc) => setIn(doc, POINTS, next), `${POINTS}.zoom`)}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, pt: 2 }}>
        {note}
      </Typography>
    </>
  );
}

/** From which zoom the points themselves draw instead of the render, as one row opening its editor; `never` names
 * what draws instead, `note` says it in the editor. */
export function PointsRow({ never, note }: { never: string; note: string }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const next = useNextLevel();
  const zoom = useStyleValue<unknown>(POINTS);
  const on = typeof zoom === "number";
  const label = t("style_editor.points");
  return (
    <GroupRow
      label={label}
      off={!on}
      value={on ? t("style_editor.points_from_zoom", { zoom }) : never}
      onOpen={(anchor) => {
        const type = store.get("render.type");
        popover.open(next, {
          key: "render:points",
          title: label,
          anchorTop: anchorTopOf(anchor),
          actions: <PointsSwitch />,
          render: () => <PointsEditor type={type} note={note} />,
        });
      }}
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
      <PointsRow never={t("style_editor.points_never")} note={t("style_editor.points_note")} />
    </PanelSection>
  );
}
