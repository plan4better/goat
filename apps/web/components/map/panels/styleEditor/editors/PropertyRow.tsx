"use client";

// One property of a part as a row: its control while the value is fixed (color, slider, choice), else a summary
// that opens the value's editor; the value mode button switches between the forms the property takes.
import { Box } from "@mui/material";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { addClassification, classifyShape, scopedView } from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import {
  type Mode,
  classificationFor,
  colorFields,
  compoundKeys,
  compoundModeOf,
  compoundStops,
  drawsHeights,
  keyOf,
  modeOf,
  modesFor,
  offersZoom,
  switchCompound,
  switchMode,
  switchScopedMode,
  writeCompound,
  writeCompoundStops,
} from "@/lib/style/editor/forms";
import { type Path, getIn, setIn } from "@/lib/style/editor/store";
import {
  choiceLabel,
  compoundLabel,
  compoundOptions,
  summarize,
  swatchOf,
} from "@/lib/style/editor/summaries";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { isObject } from "@/lib/style/json";

import { IssueNotice, useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useEditor,
  useMapZoom,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { AttributeEditor } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import {
  classificationKey,
  propLabelKey,
  useClassificationOpener,
} from "@/components/map/panels/styleEditor/editors/ClassificationEditor";
import { ColorRow } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { IconRow } from "@/components/map/panels/styleEditor/editors/IconRow";
import { ShapedIcon, markerRecordOf } from "@/components/map/panels/styleEditor/editors/ShapeField";
import { ZoomEditor } from "@/components/map/panels/styleEditor/editors/ZoomEditor";
import { choiceGlyph } from "@/components/map/panels/styleEditor/editors/choiceGlyph";
import type { PartRow } from "@/components/map/panels/styleEditor/editors/partRows";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { IconStops } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
import { PatternStops, PatternTiles } from "@/components/map/panels/styleEditor/pickers/PatternTiles";
import { useIconLabel } from "@/components/map/panels/styleEditor/pickers/iconRefs";
import { PLAIN } from "@/components/map/panels/styleEditor/plainText";
import {
  anchorTopOf,
  useIsOpen,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  GroupRow,
  OverrideDot,
  SliderRow,
  SwitchRow,
} from "@/components/map/panels/styleEditor/rows";
import { ValueModeButton } from "@/components/map/panels/styleEditor/rows/ValueModeButton";

const isNumberField = (type: string) => type === "number" || type === "integer";

export const PropertyRow = memo(function PropertyRow({ row, base }: { row: PartRow; base: Path }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const next = useNextLevel();
  const openClassification = useClassificationOpener();
  const path = base ? `${base}.${row.key}` : row.key;
  const key = keyOf(path);
  // In class scope the row shows the class's value and writes into its record (writePath).
  const { value, writePath, overridden, scoped } = useScoped(path);
  const iconName = useIconLabel(row.type === "icon" ? value : undefined);
  const scope = useScope();
  const compound = row.type === "choice" ? row.compound : undefined;
  // The record the row's key sits in (the part, or a class's or rule's part).
  const record = writePath.slice(0, writePath.length - row.key.length - 1);
  const issues = useIssueAt(compound ? `${record}.${compound.at}` : writePath);
  // The values of a stop by zoom (a compound's are its choices).
  const zoomChoices = row.type === "pattern_tiles" || row.type === "choice" ? row.values : undefined;
  // A compound row shows the values of all its keys, the layer's and the scoped record's.
  useStyleSelector((doc) =>
    compound
      ? JSON.stringify(compound.keys.map((k) => [getIn(doc, `${base}.${k}`), getIn(doc, `${record}.${k}`)]))
      : ""
  );
  // A classification that targets this key changes its mode (its shape, not every class value).
  useStyleSelector((doc) => classifyShape(doc, data.geometry));
  useStyleValue(path);
  // Heights draw with one fill opacity for the whole layer.
  const extruded = useStyleSelector((doc) => drawsHeights(doc));
  const label = t(row.label);
  const own = scoped && overridden ? writePath : path;
  // The keys of a compound the record sets itself; in scope the others are the layer's.
  const ownKeys = compound
    ? compound.keys.filter((k) => getIn(store.document, `${record}.${k}`) !== undefined)
    : [];
  const owned = compound ? scoped && ownKeys.length > 0 : overridden;
  const mode = compound
    ? compoundModeOf(
        store.document,
        compound.keys.map((k) => (scoped && ownKeys.includes(k) ? `${record}.${k}` : `${base}.${k}`)),
        data.geometry
      )
    : modeOf(store.document, own, data.geometry);
  const withColors = colorFields(data.fields, data.sample);
  // The document as the row shows it: in class or rule scope the record merged over the layer.
  const shownDoc = scope ? scopedView(store.document, scope).view : store.document;
  const modes = modesFor(key, {
    scoped,
    hasNumberField: data.fields.some((f) => isNumberField(f.type)),
    hasColorField: withColors.length > 0 || mode === "raw",
    extruded,
    // A compound's choice always has a value; another value needs one for its stops (a marker without an icon has none).
    zoom:
      !!compound ||
      offersZoom(shownDoc, path, {
        mapZoom,
        sample: data.sample,
        geometry: data.geometry,
      }),
  });
  const classify = (store.get("classify") as unknown[] | undefined) ?? [];
  const owner =
    mode === "classes"
      ? (compound ? compoundKeys(compound) : [key])
          .map((k) => classificationFor(store.document, k, data.geometry))
          .find(Boolean)
      : undefined;
  // The row is active while its value's editor is open, whether its field or the mode menu opened it.
  // The field menu of By classes, open at the mode button.
  const [classesAnchor, setClassesAnchor] = useState<HTMLElement | null>(null);
  const editorOpen =
    useIsOpen(
      `zoom:${path}`,
      `attr:${path}`,
      ...(owner ? [classificationKey(owner, classify.indexOf(owner))] : [])
    ) || classesAnchor !== null;

  /** Opens the editor of a value by zoom or by attribute, as the store holds it now. In scope the editors edit the
   * class's own value: a base by zoom is copied into the class first; a base by attribute stays the layer's (class
   * records take fixed values and values by zoom). */
  const openEditor = (to: Mode, anchorTop: number) => {
    const view = scoped && scope ? scopedView(store.document, scope) : null;
    const owns = compound
      ? compound.keys.some((k) => getIn(store.document, `${record}.${k}`) !== undefined)
      : view?.overridden(path);
    if (view && !owns) {
      if (to === "attribute") return;
      if (to === "zoom")
        if (compound)
          store.update((doc) =>
            writeCompoundStops(doc, compound, record, compoundStops(view.view, base, compound))
          );
        else store.set(writePath, structuredClone(getIn(view.view, path)));
    }
    const editPath = scoped ? writePath : path;
    if (to === "attribute")
      popover.open(next, {
        key: `attr:${path}`,
        title: t("style_editor.by_attribute_title", { label, ...PLAIN }),
        anchorTop,
        render: () => <AttributeEditor path={editPath} />,
      });
    else if (to === "zoom")
      popover.open(next, {
        key: `zoom:${path}`,
        title: t("style_editor.by_zoom_title", { label, ...PLAIN }),
        anchorTop,
        render: () => <ZoomEditor path={editPath} choices={zoomChoices} compound={compound} />,
      });
  };

  const select = (to: Mode, anchor: HTMLElement) => {
    if (to === "classes") {
      // Pick the field in a menu at the mode button; the pick adds the classification and opens its editor.
      setClassesAnchor(anchor);
      return;
    }
    const numberField = data.fields.find((f) => isNumberField(f.type))?.name;
    const field =
      to === "attribute"
        ? numberField
        : to === "raw"
          ? key === "marker.rotation"
            ? numberField
            : withColors[0]
          : undefined;
    const ctx = { mapZoom, sample: data.sample, field, geometry: data.geometry };
    store.update((doc) => {
      const view = scope ? scopedView(doc, scope).view : doc;
      // A compound keeps its choice in every mode: all its keys switch together.
      if (compound) return switchCompound(doc, view, base, record, compound, to, { ...ctx, scoped });
      return scope
        ? switchScopedMode(doc, view, path, writePath, to, ctx)
        : switchMode(doc, writePath, to, ctx);
    });
    // The new mode's editor opens at once (unless it is already open), so its values can be set right away.
    const editorKey = to === "zoom" ? `zoom:${path}` : `attr:${path}`;
    if (
      modeOf(store.document, scoped ? writePath : path, data.geometry) === to &&
      popover.current(next)?.key !== editorKey
    )
      openEditor(to, anchorTopOf(anchor));
  };
  const reset =
    scoped && owned
      ? () =>
          compound
            ? store.update((doc) =>
                compound.keys.reduce((d, k) => setIn(d, `${record}.${k}`, undefined), doc)
              )
            : store.set(writePath, undefined)
      : undefined;
  const modeButton =
    modes.length > 1 || reset ? (
      // The dot keeps the row's column gap from the button's outline.
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        {reset && <OverrideDot />}
        <ValueModeButton
          label={label}
          propertyKey={key}
          mode={mode}
          modes={modes}
          onSelect={(to, anchor) => select(to as Mode, anchor)}
          onReset={reset}
        />
        <FieldPicker
          anchorEl={classesAnchor}
          onClose={() => setClassesAnchor(null)}
          title={t("style_editor.by_classes_of", { label: t(propLabelKey(key)), ...PLAIN })}
          fields={data.fields.filter((f) => f.type !== "date" && f.type !== "datetime")}
          onChange={(name) => {
            const field = data.fields.find((f) => f.name === name);
            if (!field) return;
            const ctx = { mapZoom, sample: data.sample, geometry: data.geometry };
            // The layer keeps the value at the map zoom: classes without one of their own draw it.
            store.update((doc) =>
              addClassification(
                compound
                  ? switchCompound(doc, doc, base, base, compound, "fixed", { ...ctx, scoped: false })
                  : switchMode(doc, path, "fixed", ctx),
                key,
                field,
                data.geometry
              )
            );
            const count = (store.get("classify") as unknown[] | undefined)?.length ?? 0;
            if (classesAnchor) openClassification(count - 1, anchorTopOf(classesAnchor));
          }}
        />
      </Box>
    ) : undefined;
  // A key the layer sets once (arrows placement, label priority, …) cannot differ per class.
  if (scoped && CAPABILITIES[key]?.perFeature === false) return null;
  // Nor can the fill opacity of a layer with heights.
  if (scoped && extruded && key === "fill.opacity") return null;

  if (mode !== "fixed") {
    const fieldLabel = (name: unknown) => data.fields.find((f) => f.name === name)?.label ?? String(name);
    // A compound sums up its choices, whichever of its keys holds the stops or the classes.
    const summary =
      compound && mode === "zoom"
        ? compoundStops(shownDoc, base, compound)
            .map(([, choice]) => compoundLabel(t, compound, choice))
            .join(" → ")
        : compound && mode === "classes"
          ? t("style_editor.by_field", { field: fieldLabel(owner?.field), ...PLAIN })
          : summarize(shownDoc, path, t, {
              fields: data.fields,
              mapZoom,
              geometry: data.geometry,
              language: i18n.language,
            });
    const swatch =
      CAPABILITIES[key]?.kind === "color"
        ? { background: swatchOf(shownDoc, path, data.geometry, { scoped: !!scope }), wide: true }
        : undefined;
    return (
      <GroupRow
        label={label}
        // Icons by zoom show as their icons: names in order would not fit.
        value={
          key === "marker.icon" && mode === "zoom" ? (
            <IconStops
              value={getIn(shownDoc, path)}
              name={iconName}
              renderIcon={(ref, size) => (
                <ShapedIcon iconRef={ref} size={size} record={markerRecordOf(path)} />
              )}
            />
          ) : key === "fill.pattern" && mode === "zoom" ? (
            <PatternStops value={getIn(shownDoc, path)} />
          ) : (
            summary
          )
        }
        swatch={swatch}
        curve={mode === "zoom" && !swatch}
        mode={modeButton}
        active={editorOpen}
        warn={issues[0]?.message}
        onOpen={(anchor) => {
          if (mode === "classes") {
            const ci = classify.indexOf(owner);
            if (ci >= 0) openClassification(ci, anchorTopOf(anchor));
          } else openEditor(mode, anchorTopOf(anchor));
        }}
      />
    );
  }

  const control = fixedControl();
  // A fixed row shows its issues under it, with their fixes.
  return issues.length ? (
    <>
      {control}
      {issues.map((issue, i) => (
        <IssueNotice key={`${issue.code}-${i}`} issue={issue} />
      ))}
    </>
  ) : (
    control
  );

  function fixedControl() {
    const own = getIn(shownDoc, base);
    const part = isObject(own) ? own : {};
    const fallback =
      typeof row.fallback === "function" ? row.fallback(part) : (row.fallback ?? DEFAULTS[key]);
    const noteKey = typeof row.note === "function" ? row.note(part) : row.note;
    const note = noteKey ? t(noteKey) : undefined;
    switch (row.type) {
      case "color":
        return (
          <ColorRow
            label={label}
            path={writePath}
            fallback={
              scoped && typeof value === "string"
                ? value
                : typeof row.fallback === "function" && typeof fallback === "string"
                  ? fallback
                  : undefined
            }
            sentinel={row.sentinel}
            note={note}
            mode={modeButton}
          />
        );
      case "icon":
        return (
          <IconRow
            label={label}
            path={writePath}
            fallback={value ?? fallback}
            mode={modeButton}
            note={note}
          />
        );
      case "switch":
        return (
          <SwitchRow
            label={label}
            on={value === true || (value === undefined && fallback === true)}
            onToggle={() => store.set(writePath, !(value ?? fallback))}
            note={note}
          />
        );
      case "number": {
        const range = SLIDERS[key] ?? { min: 0, max: 100, step: 1 };
        return (
          <SliderRow
            label={label}
            min={range.min}
            max={range.max}
            step={range.step}
            unit={range.unit}
            pct={range.pct}
            value={typeof value === "number" ? value : (fallback as number)}
            onChange={(next) => store.set(writePath, next)}
            mode={modeButton}
            note={note}
          />
        );
      }
      case "pattern_tiles":
        return (
          <PatternTiles
            label={label}
            values={row.values}
            value={String(value ?? fallback)}
            onChange={(next) => store.set(writePath, next)}
            mode={modeButton}
          />
        );
      case "pattern":
        return null;
      case "choice":
        return (
          <ChoiceRow<string>
            label={label}
            value={compound ? compound.read(part) : String(value ?? fallback)}
            options={
              compound
                ? compoundOptions(t, compound)
                : row.values.map((v) => ({
                    value: v,
                    label: choiceLabel(t, key, v),
                    sub: row.subs?.includes(v)
                      ? t(`style_editor.value_${key.replace(/\./g, "_")}_${v}_sub`)
                      : undefined,
                    icon: choiceGlyph(key, v, data.geometry),
                  }))
            }
            onChange={(next) =>
              compound
                ? store.update((doc) => writeCompound(doc, compound, record, next, scoped))
                : store.set(writePath, next)
            }
            mode={modeButton}
            note={note}
          />
        );
    }
  }
});
