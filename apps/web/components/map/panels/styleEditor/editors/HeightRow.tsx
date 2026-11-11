"use client";

// Height for polygons (3D spec 8.4): the `extrude` part as a group row of the Polygons section, like Fill and Outline,
// opening its editor in a popover with the part's switch in the header. Height is None, Fixed, By zoom, By attribute (a number
// field read as it is, metres or storeys) or By classes; while Height is set, Base height (Fixed or By attribute); the
// unit while either reads a field. The first height on a 2D map tilts it to 3D once, with Undo; a layer whose tilt
// was undone says "Viewing in 2D · Show in 3D" under the row instead.
import { Box, Button, Typography } from "@mui/material";
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { addClassification, classifyShape, recordPathOf, scopedView } from "@/lib/style/editor/classify";
import {
  type Mode,
  classificationFor,
  modeOf,
  switchMode,
  switchScopedMode,
} from "@/lib/style/editor/forms";
import { type Path, getIn, setIn } from "@/lib/style/editor/store";
import { summarize } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import type { LayerStyle } from "@/lib/style/generated/types";
import { isObject } from "@/lib/style/json";

import { useAutoTilt } from "@/hooks/map/useAutoTilt";

import {
  useEditor,
  useMapZoom,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import {
  classificationKey,
  useClassificationOpener,
} from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { HeaderSwitch, PartZooms, togglePart } from "@/components/map/panels/styleEditor/editors/PartEditor";
import { ZoomEditor } from "@/components/map/panels/styleEditor/editors/ZoomEditor";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import {
  anchorTopOf,
  useIsOpen,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { FormButton, GroupRow, Row, SegmentedRow, SliderRow } from "@/components/map/panels/styleEditor/rows";
import { FieldButton } from "@/components/map/panels/styleEditor/rows/FieldButton";
import { type ModeChoice, ValueModeButton } from "@/components/map/panels/styleEditor/rows/ValueModeButton";

/** Number fields named for a height, listed first in the field picker (lower-case). */
export const HEIGHT_FIELDS = [
  "height",
  "render_height",
  "building_height",
  "levels",
  "building_levels",
  "storeys",
  "floors",
] as const;
/** The fields that count storeys: picking one reads it as storeys. */
const STOREY_FIELDS = ["levels", "building_levels", "storeys", "floors"];

const PART = "symbol.extrude";
/** The Height slider's range (the style takes up to 5000 m; the number field takes any). */
const HEIGHT_SLIDER = { min: 0, max: 200, step: 1, unit: "m" };

const isNumberField = (type: string) => type === "number" || type === "integer";

/** Whether the value at `path` reads a field as it is (By attribute of a height: metres or storeys). */
const rawField = (value: unknown): value is { field: string } =>
  isObject(value) && typeof value.field === "string" && !("range" in value);

/** The editor of the height part: the layer's, or in class scope the class's (written into its record). */
function useHeightPart() {
  const { value: part, scoped } = useScoped(PART);
  return { on: isObject(part), scoped };
}

/** One value of the height part: Height or Base height. */
function ExtrudeValueRow({ prop, on }: { prop: "height" | "base"; on: boolean }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const next = useNextLevel();
  const scope = useScope();
  const openClassification = useClassificationOpener();
  const { tilt } = useAutoTilt(data.layerId);
  const path: Path = `${PART}.${prop}`;
  const key = `extrude.${prop}`;
  const { value, writePath, scoped, overridden } = useScoped(path);
  useStyleSelector((doc) => classifyShape(doc, data.geometry));
  // A height read from a field says its unit.
  useStyleValue(`${PART}.unit`);
  const label = t(prop === "height" ? "style_editor.height" : "style_editor.base_height");
  const modeBox = useRef<HTMLDivElement | null>(null);
  // The field menu: for a height read from a field, or for the classes' field.
  const [menu, setMenu] = useState<{ purpose: "raw" | "classes"; anchor: HTMLElement } | null>(null);
  const own = scoped && overridden ? writePath : path;
  const mode: ModeChoice = !on ? "none" : modeOf(store.document, own, data.geometry);
  const numberFields = data.fields.filter((f) => isNumberField(f.type));
  const modes: ModeChoice[] =
    prop === "base"
      ? ["fixed", ...(numberFields.length && !scoped ? (["raw"] as const) : [])]
      : scoped
        ? ["fixed", "zoom"]
        : ["none", "fixed", "zoom", ...(numberFields.length ? (["raw"] as const) : []), "classes"];
  const classify = (store.get("classify") as unknown[] | undefined) ?? [];
  const owner = mode === "classes" ? classificationFor(store.document, key, data.geometry) : undefined;
  const editorOpen =
    useIsOpen(`zoom:${path}`, ...(owner ? [classificationKey(owner, classify.indexOf(owner))] : [])) ||
    menu !== null;
  const ctx = { mapZoom, sample: data.sample, geometry: data.geometry };
  /** The document with the part on (a height part with nothing set draws the default height). */
  const withPart = (doc: LayerStyle) => (isObject(getIn(doc, PART)) ? doc : setIn(doc, PART, {}));

  const openZoom = (anchorTop: number) =>
    popover.open(next, {
      key: `zoom:${path}`,
      title: t("style_editor.by_zoom_title", { label }),
      anchorTop,
      render: () => <ZoomEditor path={scoped ? writePath : path} />,
    });
  const pickField = (name: string) => {
    const fromNone = !on;
    store.update((doc) => {
      let next = setIn(withPart(doc), path, { field: name });
      if (prop === "height")
        next = setIn(next, `${PART}.unit`, STOREY_FIELDS.includes(name.toLowerCase()) ? "storeys" : undefined);
      return next;
    });
    tilt(fromNone);
  };
  const pickClassesField = (name: string, anchor: HTMLElement) => {
    const field = data.fields.find((f) => f.name === name);
    if (!field) return;
    const fromNone = !on;
    store.update((doc) =>
      addClassification(switchMode(withPart(doc), path, "fixed", ctx), key, field, data.geometry)
    );
    const count = (store.get("classify") as unknown[] | undefined)?.length ?? 0;
    openClassification(count - 1, anchorTopOf(anchor));
    tilt(fromNone);
  };

  const select = (to: ModeChoice, anchor: HTMLElement) => {
    const fromNone = !on;
    if (to === mode) {
      if (to === "zoom") openZoom(anchorTopOf(anchor));
      if (to === "raw") setMenu({ purpose: "raw", anchor });
      return;
    }
    if (to === "none") {
      // Leaves the classifications of the height with the part.
      store.update((doc) => setIn(switchMode(doc, path, "fixed", ctx), PART, undefined));
      return;
    }
    if (to === "raw" || to === "classes") return setMenu({ purpose: to, anchor });
    store.update((doc) => {
      if (scope) return switchScopedMode(doc, scopedView(doc, scope).view, path, writePath, to, ctx);
      // Off: the height starts at its reference default.
      const base = on ? doc : setIn(doc, PART, prop === "height" ? { height: DEFAULTS[key] } : {});
      // A unit only reads a field: a fixed or zoom height is in metres.
      const unitless = prop === "height" ? setIn(base, `${PART}.unit`, undefined) : base;
      return to === "fixed" && !on ? unitless : switchMode(unitless, path, to as Mode, ctx);
    });
    if (to === "zoom") openZoom(anchorTopOf(anchor));
    tilt(fromNone);
  };

  const modeButton = (
    <ValueModeButton
      label={label}
      propertyKey={key}
      mode={mode}
      modes={modes}
      onSelect={select}
      labels={{ raw: t("style_editor.mode_attribute") }}
      subs={
        prop === "height"
          ? {
              none: t("style_editor.height_none_sub"),
              fixed: t("style_editor.height_fixed_sub"),
              zoom: t("style_editor.height_zoom_sub"),
              raw: t("style_editor.height_field_sub"),
              classes: t("style_editor.height_classes_sub"),
            }
          : { fixed: t("style_editor.base_fixed_sub"), raw: t("style_editor.base_field_sub") }
      }
    />
  );
  const fieldMenu = (
    <FieldPicker
      anchorEl={menu?.anchor ?? null}
      onClose={() => setMenu(null)}
      title={menu?.purpose === "classes" ? t("style_editor.by_classes_of", { label }) : undefined}
      fields={
        menu?.purpose === "classes"
          ? data.fields.filter((f) => f.type !== "date" && f.type !== "datetime")
          : data.fields
      }
      filter={menu?.purpose === "raw" ? "number" : undefined}
      value={menu?.purpose === "raw" && rawField(value) ? value.field : undefined}
      suggested={
        prop === "height" && menu?.purpose === "raw"
          ? {
              names: HEIGHT_FIELDS,
              title: t("style_editor.height_suggested"),
              othersTitle: t("style_editor.height_other_fields"),
            }
          : undefined
      }
      onChange={(name) => {
        if (menu?.purpose === "classes") pickClassesField(name, menu.anchor);
        else pickField(name);
      }}
    />
  );
  const actions = (
    // The field menu opens at the mode button or at the row's field; it draws in a portal.
    <Box ref={modeBox} sx={{ display: "flex" }}>
      {modeButton}
      {fieldMenu}
    </Box>
  );

  if (mode === "none")
    return (
      <Row label={label} actions={actions}>
        {/* The value opens the mode menu, as the canvas's "None" field does. */}
        <FieldButton
          popup="menu"
          onClick={() => modeBox.current?.querySelector<HTMLButtonElement>("button")?.click()}>
          <Typography component="span" variant="body2" fontWeight="bold" color="text.primary">
            {t("style_editor.none")}
          </Typography>
        </FieldButton>
      </Row>
    );
  if (mode === "fixed")
    return (
      <SliderRow
        label={label}
        {...HEIGHT_SLIDER}
        value={typeof value === "number" ? value : (DEFAULTS[key] as number)}
        onChange={(v) => store.set(writePath, v)}
        mode={actions}
      />
    );
  const storeys = getIn(store.document, `${PART}.unit`) === "storeys";
  if (mode === "raw")
    // A field picked from a list: the field opens the field menu under it.
    return (
      <Row label={label} actions={actions} active={editorOpen}>
        <FormButton
          popup="listbox"
          open={menu?.purpose === "raw"}
          text={
            rawField(value)
              ? t(storeys ? "style_editor.height_storeys_value" : "style_editor.height_metres_value", {
                  field: data.fields.find((f) => f.name === value.field)?.label ?? value.field,
                  storey: SCENE_DEFAULTS.storey_height,
                })
              : ""
          }
          onOpen={(anchor) => setMenu(menu ? null : { purpose: "raw", anchor })}
        />
      </Row>
    );
  const shown = scope ? scopedView(store.document, scope).view : store.document;
  return (
    <GroupRow
      label={label}
      value={summarize(shown, path, t, { fields: data.fields, mapZoom, geometry: data.geometry })}
      curve={mode === "zoom"}
      mode={actions}
      active={editorOpen}
      onOpen={(anchor) => {
        if (mode === "zoom") openZoom(anchorTopOf(anchor));
        else if (mode === "classes") {
          const ci = classify.indexOf(owner);
          if (ci >= 0) openClassification(ci, anchorTopOf(anchor));
        }
      }}
    />
  );
}

/** "Viewing in 2D · Show in 3D": a height the 2D map draws flat. */
export function ViewingIn2D({ onShow }: { onShow: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 3, pb: 1, color: "text.secondary" }}>
      <Icon iconName={ICON_NAME.CUBE} sx={{ fontSize: 14 }} />
      <Typography variant="caption">{t("style_editor.height_viewing_2d")}</Typography>
      <Typography variant="caption" aria-hidden="true">
        ·
      </Typography>
      <Button
        variant="text"
        size="small"
        onClick={onShow}
        sx={{ textTransform: "none", minWidth: 0, p: 0, typography: "caption", fontWeight: 700 }}>
        {t("style_editor.height_show_3d")}
      </Button>
    </Box>
  );
}

/** The height part's switch, for its editor's header: off remembers the part, on brings it back (the default height
 * when there is nothing to bring back) and tilts a 2D map as a first height does. */
export function HeightSwitch() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const scope = useScope();
  const { layerId } = useStyleData();
  const { tilt } = useAutoTilt(layerId);
  const { on } = useHeightPart();
  return (
    <HeaderSwitch
      name={t("style_editor.part_name_height")}
      on={on}
      onToggle={() => {
        togglePart(store, scope ? `${recordPathOf(scope)}.extrude` : PART, !on);
        tilt(!on);
      }}
    />
  );
}

/** The height part's editor: Height, then while it is set Base height, the unit while either reads a field, and the
 * zooms it shows at. */
export function HeightEditor() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { on, scoped } = useHeightPart();
  const { value: height } = useScoped(`${PART}.height`);
  const { value: base } = useScoped(`${PART}.base`);
  const unit = getIn(store.document, `${PART}.unit`) === "storeys" ? "storeys" : "m";
  return (
    <>
      <ExtrudeValueRow prop="height" on={on} />
      {on && !scoped && <ExtrudeValueRow prop="base" on />}
      {on && !scoped && (rawField(height) || rawField(base)) && (
        <SegmentedRow
          label={t("style_editor.height_unit")}
          value={unit}
          options={[
            { value: "m", label: t("style_editor.height_unit_m") },
            {
              value: "storeys",
              label: t("style_editor.height_unit_storeys", { storey: SCENE_DEFAULTS.storey_height }),
            },
          ]}
          onChange={(next) => store.set(`${PART}.unit`, next === "storeys" ? "storeys" : undefined)}
        />
      )}
      {/* Where the volumes stand, as Fill and Outline say where they draw; outside it they are flat. */}
      {on && <PartZooms base={PART} />}
    </>
  );
}

/** The Height row of the Polygons section: what the height is ("None", "10 m", "By Hoehe · storeys"), opening the
 * height editor. */
export const HeightRow = memo(function HeightRow() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const next = useNextLevel();
  const scope = useScope();
  const { on } = useHeightPart();
  const { value: height, overridden, scoped, writePath } = useScoped(`${PART}.height`);
  useStyleValue(`${PART}.unit`);
  useStyleSelector((doc) => classifyShape(doc, data.geometry));
  const { mode, show3d } = useAutoTilt(data.layerId);
  const label = t("style_editor.height");
  const shown = scope ? scopedView(store.document, scope).view : store.document;
  // In class scope a class's own value is the class's, whatever the layer's height is.
  const heightMode = on
    ? modeOf(store.document, scoped && overridden ? writePath : `${PART}.height`, data.geometry)
    : "fixed";
  let text = !on
    ? t("style_editor.none")
    : heightMode === "fixed"
      ? `${typeof height === "number" ? height : DEFAULTS["extrude.height"]} m`
      : summarize(shown, `${PART}.height`, t, { fields: data.fields, mapZoom, geometry: data.geometry });
  if (on && getIn(store.document, `${PART}.unit`) === "storeys")
    text = t("style_editor.height_summary_storeys", { value: text });
  return (
    <>
      <GroupRow
        label={label}
        off={!on}
        value={text}
        curve={on && heightMode === "zoom"}
        overrideDot={overridden}
        onOpen={(anchor) =>
          popover.open(next, {
            key: "part:height",
            title: label,
            anchorTop: anchorTopOf(anchor),
            actions: <HeightSwitch />,
            render: () => <HeightEditor />,
          })
        }
      />
      {on && mode === "2d" && <ViewingIn2D onShow={show3d} />}
    </>
  );
});
