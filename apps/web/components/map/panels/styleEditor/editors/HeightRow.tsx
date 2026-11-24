"use client";

// Height for polygons (3D spec 8.4): the `extrude` part as a group row of the Polygons section, like Fill and Outline,
// opening its editor in a popover with the part's switch in the header. Height is None, Fixed, By zoom, By attribute (a
// number field over a range of heights, in metres), Field values (a number field read as it is, metres or storeys) or By
// classes; while Height is set, Base height takes the same forms but None; the unit while either reads a field's values.
// The first height on a 2D map tilts it to 3D once, with Undo; a layer whose tilt was undone says "Viewing in 2D. Show
// in 3D" under the row instead.
import { Box, Button, Link, Typography } from "@mui/material";
import { memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { partUsed } from "@/lib/style/compile/cascade";
import { addClassification, classifyShape, recordPathOf, scopedView } from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import {
  type Mode,
  classificationFor,
  modeOf,
  oneFillOpacity,
  switchMode,
  switchScopedMode,
} from "@/lib/style/editor/forms";
import { partSetter, partState, perLayerPath, setterKey } from "@/lib/style/editor/sources";
import { type Path, getIn, setIn } from "@/lib/style/editor/store";
import { setterSummary, summarize, summaryNumber } from "@/lib/style/editor/summaries";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { SCENE_DEFAULTS } from "@/lib/style/generated/scene";
import type { LayerStyle } from "@/lib/style/generated/types";
import { type JsonObject, isObject } from "@/lib/style/json";

import { useAutoTilt } from "@/hooks/map/useAutoTilt";

import {
  useEditor,
  useMapZoom,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
} from "@/components/map/panels/styleEditor/context";
import { AttributeEditor } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import {
  classificationKey,
  useClassificationOpener,
} from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import {
  HeaderSwitch,
  PartZooms,
  SetByRow,
  allowPerClass,
  togglePart,
} from "@/components/map/panels/styleEditor/editors/PartEditor";
import { ZoomEditor } from "@/components/map/panels/styleEditor/editors/ZoomEditor";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { PLAIN } from "@/components/map/panels/styleEditor/plainText";
import { ResetToDataset } from "@/components/map/panels/styleEditor/popovers/ResetToDataset";
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
/** Where the height unit is read and written: one for the layer, wherever it is set (spec 6.1). */
const unitPath = (doc: LayerStyle): Path => perLayerPath(doc, `${PART}.unit`);
/** The Height slider's range (the style takes up to 5000 m; the number field takes any). */
const HEIGHT_SLIDER = SLIDERS["extrude.height"];

const isNumberField = (type: string) => type === "number" || type === "integer";

/** Whether the value at `path` reads a field as it is (Field values of a height: metres or storeys). */
const rawField = (value: unknown): value is { field: string } =>
  isObject(value) && typeof value.field === "string" && !("range" in value);

/** The editor of the height part: the layer's, or in class scope the class's (written into its record). For all
 * features, `some` names what draws heights while the layer leaves them out (`setterKey`). */
function useHeightPart() {
  const { value: part, scoped } = useScoped(PART);
  const some = useStyleSelector((doc) =>
    scoped || partState(doc, "extrude", "polygon") !== "some" ? "" : setterKey(partSetter(doc, "extrude"))
  );
  // Heights the layer switches off while classes or rules carry them.
  const carriedOff = useStyleSelector(
    (doc) =>
      !scoped &&
      getIn(doc, PART) === false &&
      partUsed({ ...doc, symbol: {} } as unknown as JsonObject, "extrude")
  );
  return { on: isObject(part), scoped, some, carriedOff };
}

/** One value of the height part: Height or Base height. */
function ExtrudeValueRow({ prop, on }: { prop: "height" | "base"; on: boolean }) {
  const { t, i18n } = useTranslation("common");
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
  useStyleSelector((doc) => String(getIn(doc, unitPath(doc))));
  const label = t(prop === "height" ? "style_editor.height" : "style_editor.base_height");
  // The popover is titled Height: its rows are the top and the bottom (titles and the mode menu keep the full names).
  const rowLabel = t(prop === "height" ? "style_editor.height_top" : "style_editor.height_bottom");
  const modeBox = useRef<HTMLDivElement | null>(null);
  // The field menu: for a height read from a field, or for the classes' field.
  const [menu, setMenu] = useState<{ purpose: "raw" | "classes"; anchor: HTMLElement } | null>(null);
  const own = scoped && overridden ? writePath : path;
  const mode: ModeChoice = !on ? "none" : modeOf(store.document, own, data.geometry);
  const numberFields = data.fields.filter((f) => isNumberField(f.type));
  // A class takes a fixed height or one by zoom; the layer's height and base take every form (spec 3.6), the base
  // never None.
  const fromField = numberFields.length ? (["attribute", "raw"] as const) : [];
  const modes: ModeChoice[] = scoped
    ? ["fixed", "zoom"]
    : [...(prop === "height" ? (["none"] as const) : []), "fixed", "zoom", ...fromField, "classes"];
  const classify = (store.get("classify") as unknown[] | undefined) ?? [];
  const owner = mode === "classes" ? classificationFor(store.document, key, data.geometry) : undefined;
  const editorOpen =
    useIsOpen(
      `zoom:${path}`,
      `attr:${path}`,
      ...(owner ? [classificationKey(owner, classify.indexOf(owner))] : [])
    ) || menu !== null;
  const ctx = { mapZoom, sample: data.sample, geometry: data.geometry };
  /** The document with the part on (a height part with nothing set draws the default height). */
  const withPart = (doc: LayerStyle) => (isObject(getIn(doc, PART)) ? doc : setIn(doc, PART, {}));

  const openZoom = (anchorTop: number) =>
    popover.open(next, {
      key: `zoom:${path}`,
      title: t("style_editor.by_zoom_title", { label, ...PLAIN }),
      anchorTop,
      render: () => <ZoomEditor path={scoped ? writePath : path} />,
    });
  // A field over a range of heights: the layer's only, as classes take fixed heights and heights by zoom.
  const openAttribute = (anchorTop: number) =>
    popover.open(next, {
      key: `attr:${path}`,
      title: t("style_editor.by_attribute_title", { label, ...PLAIN }),
      anchorTop,
      render: () => <AttributeEditor path={path} />,
    });
  const pickField = (name: string) => {
    const fromNone = !on;
    store.update((doc) => {
      let next = setIn(withPart(doc), path, { field: name });
      if (prop === "height")
        next = setIn(
          next,
          unitPath(next),
          STOREY_FIELDS.includes(name.toLowerCase()) ? "storeys" : undefined
        );
      return oneFillOpacity(next, ctx);
    });
    tilt(fromNone);
  };
  const pickClassesField = (name: string, anchor: HTMLElement) => {
    const field = data.fields.find((f) => f.name === name);
    if (!field) return;
    const fromNone = !on;
    store.update((doc) =>
      oneFillOpacity(
        addClassification(switchMode(withPart(doc), path, "fixed", ctx), key, field, data.geometry),
        ctx
      )
    );
    const count = (store.get("classify") as unknown[] | undefined)?.length ?? 0;
    openClassification(count - 1, anchorTopOf(anchor));
    tilt(fromNone);
  };

  /** `doc` with the height or base switched to `to`. */
  const switchHeight = (doc: LayerStyle, to: ModeChoice): LayerStyle => {
    if (scope) return switchScopedMode(doc, scopedView(doc, scope).view, path, writePath, to as Mode, ctx);
    // Off: the height starts at its reference default.
    const base = on ? doc : setIn(doc, PART, prop === "height" ? { height: DEFAULTS[key] } : {});
    // A unit only reads a field's values: a fixed height, one by zoom and a range of heights are in metres.
    const unitless = prop === "height" ? setIn(base, unitPath(base), undefined) : base;
    // By attribute starts on the field the height reads, else the first number field; its editor changes it.
    const field = rawField(value) ? value.field : numberFields[0]?.name;
    return to === "fixed" && !on ? unitless : switchMode(unitless, path, to as Mode, { ...ctx, field });
  };

  const select = (to: ModeChoice, anchor: HTMLElement) => {
    const fromNone = !on;
    if (to === mode) {
      if (to === "zoom") openZoom(anchorTopOf(anchor));
      if (to === "attribute") openAttribute(anchorTopOf(anchor));
      if (to === "raw") setMenu({ purpose: "raw", anchor });
      return;
    }
    if (to === "none") {
      // Leaves the classifications of the height with the part.
      store.update((doc) => setIn(switchMode(doc, path, "fixed", ctx), PART, undefined));
      return;
    }
    if (to === "raw" || to === "classes") return setMenu({ purpose: to, anchor });
    // Heights take one fill opacity, in the same edit.
    store.update((doc) => oneFillOpacity(switchHeight(doc, to), ctx));
    if (to === "zoom") openZoom(anchorTopOf(anchor));
    if (to === "attribute") openAttribute(anchorTopOf(anchor));
    tilt(fromNone);
  };

  const modeButton = (
    <ValueModeButton
      label={label}
      propertyKey={key}
      mode={mode}
      modes={modes}
      onSelect={select}
      subs={
        prop === "height"
          ? {
              none: t("style_editor.height_none_sub"),
              fixed: t("style_editor.height_fixed_sub"),
              zoom: t("style_editor.height_zoom_sub"),
              attribute: t("style_editor.height_attribute_sub"),
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
      title={menu?.purpose === "classes" ? t("style_editor.by_classes_of", { label, ...PLAIN }) : undefined}
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
      <Row label={rowLabel} actions={actions}>
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
        label={rowLabel}
        {...HEIGHT_SLIDER}
        value={typeof value === "number" ? value : (DEFAULTS[key] as number)}
        onChange={(v) => store.set(writePath, v)}
        mode={actions}
      />
    );
  const storeys = getIn(store.document, unitPath(store.document)) === "storeys";
  if (mode === "raw")
    // A field picked from a list: the field opens the field menu under it.
    return (
      <Row label={rowLabel} actions={actions} active={editorOpen}>
        <FormButton
          popup="listbox"
          open={menu?.purpose === "raw"}
          text={
            rawField(value)
              ? t(storeys ? "style_editor.height_storeys_value" : "style_editor.height_metres_value", {
                  field: data.fields.find((f) => f.name === value.field)?.label ?? value.field,
                  storey: SCENE_DEFAULTS.storey_height,
                  ...PLAIN,
                })
              : ""
          }
          onOpen={(anchor) => setMenu(menu ? null : { purpose: "raw", anchor })}
        />
      </Row>
    );
  return (
    <GroupRow
      label={rowLabel}
      value={summarize(store.document, path, t, {
        scope,
        fields: data.fields,
        mapZoom,
        geometry: data.geometry,
        language: i18n.language,
      })}
      curve={mode === "zoom"}
      mode={actions}
      active={editorOpen}
      onOpen={(anchor) => {
        if (mode === "zoom") openZoom(anchorTopOf(anchor));
        // In class scope a height by attribute is the layer's: a class has no editor for it.
        else if (mode === "attribute" && !scoped) openAttribute(anchorTopOf(anchor));
        else if (mode === "classes") {
          const ci = classify.indexOf(owner);
          if (ci >= 0) openClassification(ci, anchorTopOf(anchor));
        }
      }}
    />
  );
}

/** "Viewing in 2D. Show in 3D", the note of a height row while the 2D map draws the height flat: the way to 3D as a
 * text link. */
export function ViewingIn2D({ onShow }: { onShow: () => void }) {
  const { t } = useTranslation("common");
  return (
    <>
      {t("style_editor.height_viewing_2d")}{" "}
      <Link
        component="button"
        type="button"
        variant="caption"
        underline="hover"
        onClick={onShow}
        sx={{ verticalAlign: "baseline" }}>
        {t("style_editor.height_show_3d")}
      </Link>
    </>
  );
}

/** The height part's switch, for its editor's header: off remembers the part, on brings it back (the default height
 * when there is nothing to bring back) and tilts a 2D map as a first height does. */
export function HeightSwitch() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const scope = useScope();
  const { layerId, sample, geometry } = useStyleData();
  const mapZoom = useMapZoom();
  const { tilt } = useAutoTilt(layerId);
  const { on } = useHeightPart();
  return (
    <HeaderSwitch
      name={t("style_editor.part_name_height")}
      on={on}
      onToggle={() => {
        // Heights take one fill opacity, in the same edit.
        togglePart(store, scope ? `${recordPathOf(scope)}.extrude` : PART, !on, (doc) =>
          oneFillOpacity(doc, { mapZoom, sample, geometry })
        );
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
  const { on, scoped, some, carriedOff } = useHeightPart();
  const { value: height } = useScoped(`${PART}.height`);
  const { value: base } = useScoped(`${PART}.base`);
  const unit = getIn(store.document, unitPath(store.document)) === "storeys" ? "storeys" : "m";
  return (
    <>
      {some && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 2 }}>
          {t("style_editor.part_some_note")}
        </Typography>
      )}
      {some && <SetByRow setterOf={(doc) => partSetter(doc, "extrude")} />}
      {carriedOff && (
        <Box sx={{ px: 3, py: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {t("style_editor.part_off_for_layer_allow")}
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => allowPerClass(store, PART)}
            sx={{ textTransform: "none", mt: 1, ml: -1 }}>
            {t("style_editor.allow_per_class")}
          </Button>
        </Box>
      )}
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
          onChange={(next) => store.set(unitPath(store.document), next === "storeys" ? "storeys" : undefined)}
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
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const next = useNextLevel();
  const scope = useScope();
  const { on, some } = useHeightPart();
  const { value: height, overridden, scoped, writePath } = useScoped(`${PART}.height`);
  useStyleSelector((doc) => String(getIn(doc, unitPath(doc))));
  useStyleSelector((doc) => classifyShape(doc, data.geometry));
  const { mode, show3d } = useAutoTilt(data.layerId);
  const label = t("style_editor.height");
  // In class scope a class's own value is the class's, whatever the layer's height is.
  const heightMode = on
    ? modeOf(store.document, scoped && overridden ? writePath : `${PART}.height`, data.geometry)
    : "fixed";
  const ctx = { fields: data.fields, mapZoom, geometry: data.geometry, language: i18n.language };
  let text = !on
    ? some
      ? setterSummary(t, some, data.fields)
      : t("style_editor.none")
    : heightMode === "fixed"
      ? summaryNumber(
          typeof height === "number" ? height : (DEFAULTS["extrude.height"] as number),
          "extrude.height",
          ctx.language
        )
      : summarize(store.document, `${PART}.height`, t, { ...ctx, scope });
  if (on && getIn(store.document, unitPath(store.document)) === "storeys")
    text = t("style_editor.height_summary_storeys", { value: text, ...PLAIN });
  return (
    <GroupRow
      label={label}
      off={!on && !some}
      value={text}
      curve={on && heightMode === "zoom"}
      overrideDot={overridden}
      note={on && mode === "2d" ? <ViewingIn2D onShow={show3d} /> : undefined}
      onOpen={(anchor) =>
        popover.open(next, {
          key: "part:height",
          title: label,
          anchorTop: anchorTopOf(anchor),
          actions: (
            <>
              <ResetToDataset paths={[PART]} />
              <HeightSwitch />
            </>
          ),
          render: () => <HeightEditor />,
        })
      }
    />
  );
});
