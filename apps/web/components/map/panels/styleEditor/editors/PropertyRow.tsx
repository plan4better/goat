"use client";

// One property of a part as a row: its control while the value is fixed (color, slider, choice), else a summary
// that opens the value's editor; the value mode button switches between the forms the property takes.
import { Box } from "@mui/material";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { addClassification, classifyShape, scopedView } from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import {
  type Mode,
  classificationFor,
  colorFields,
  keyOf,
  modeOf,
  modesFor,
  switchMode,
  switchScopedMode,
} from "@/lib/style/editor/forms";
import { type Path, getIn } from "@/lib/style/editor/store";
import { choiceLabel, summarize, swatchOf } from "@/lib/style/editor/summaries";
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
  const { t } = useTranslation("common");
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
  const issues = useIssueAt(writePath);
  // A classification that targets this key changes its mode (its shape, not every class value).
  useStyleSelector((doc) => classifyShape(doc, data.geometry));
  useStyleValue(path);
  const label = t(row.label);
  const note = row.note ? t(row.note) : undefined;
  const own = scoped && overridden ? writePath : path;
  const mode = modeOf(store.document, own, data.geometry);
  const withColors = colorFields(data.fields, data.sample);
  const modes = modesFor(key, {
    scoped,
    hasNumberField: data.fields.some((f) => isNumberField(f.type)),
    hasColorField: withColors.length > 0 || mode === "raw",
  });
  const classify = (store.get("classify") as unknown[] | undefined) ?? [];
  const owner = mode === "classes" ? classificationFor(store.document, key, data.geometry) : undefined;
  // The row is active while its value's editor is open, whether its field or the mode menu opened it.
  const editorOpen = useIsOpen(
    `zoom:${path}`,
    `attr:${path}`,
    `classes-field:${path}`,
    ...(owner ? [classificationKey(owner, classify.indexOf(owner))] : [])
  );

  /** Opens the editor of a value by zoom or by attribute, as the store holds it now. In scope the editors edit the
   * class's own value: a base by zoom is copied into the class first; a base by attribute stays the layer's (class
   * records take fixed values and values by zoom). */
  const openEditor = (to: Mode, anchorTop: number) => {
    const view = scoped && scope ? scopedView(store.document, scope) : null;
    if (view && !view.overridden(path)) {
      if (to === "attribute") return;
      if (to === "zoom") store.set(writePath, structuredClone(getIn(view.view, path)));
    }
    const editPath = scoped ? writePath : path;
    if (to === "attribute")
      popover.open(next, {
        key: `attr:${path}`,
        title: t("style_editor.by_attribute_title", { label }),
        anchorTop,
        render: () => <AttributeEditor path={editPath} />,
      });
    else if (to === "zoom")
      popover.open(next, {
        key: `zoom:${path}`,
        title: t("style_editor.by_zoom_title", { label }),
        anchorTop,
        render: () => (
          <ZoomEditor
            path={editPath}
            choices={row.type === "choice" || row.type === "pattern_tiles" ? row.values : undefined}
          />
        ),
      });
  };

  const select = (to: Mode, anchor: HTMLElement) => {
    if (to === "classes") {
      // Pick the field, add the classification, open its editor.
      popover.open(next, {
        key: `classes-field:${path}`,
        transient: true,
        title: t("style_editor.by_classes_of", { label: t(propLabelKey(key)) }),
        anchorTop: anchorTopOf(anchor),
        render: () => (
          <FieldPicker
            fields={data.fields.filter((f) => f.type !== "date" && f.type !== "datetime")}
            onChange={(name) => {
              const field = data.fields.find((f) => f.name === name);
              if (!field) return;
              const ctx = { mapZoom, sample: data.sample, geometry: data.geometry };
              store.update((doc) =>
                addClassification(switchMode(doc, path, "fixed", ctx), key, field, data.geometry)
              );
              const count = (store.get("classify") as unknown[] | undefined)?.length ?? 0;
              openClassification(count - 1, anchorTopOf(anchor));
            }}
          />
        ),
      });
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
    store.update((doc) =>
      scope
        ? switchScopedMode(doc, scopedView(doc, scope).view, path, writePath, to, ctx)
        : switchMode(doc, writePath, to, ctx)
    );
    // The new mode's editor opens at once (unless it is already open), so its values can be set right away.
    const editorKey = to === "zoom" ? `zoom:${path}` : `attr:${path}`;
    if (
      modeOf(store.document, scoped ? writePath : path, data.geometry) === to &&
      popover.current(next)?.key !== editorKey
    )
      openEditor(to, anchorTopOf(anchor));
  };
  const reset = scoped && overridden ? () => store.set(writePath, undefined) : undefined;
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
          onSelect={select}
          onReset={reset}
        />
      </Box>
    ) : undefined;
  // A key the layer sets once (arrows placement, label priority, …) cannot differ per class.
  if (scoped && CAPABILITIES[key]?.perFeature === false) return null;
  const shownDoc = scope ? scopedView(store.document, scope).view : store.document;

  if (mode !== "fixed") {
    const summary = summarize(shownDoc, path, t, {
      fields: data.fields,
      mapZoom,
      geometry: data.geometry,
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
    const fallback =
      typeof row.fallback === "function"
        ? row.fallback(isObject(own) ? own : {})
        : (row.fallback ?? DEFAULTS[key]);
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
        return <IconRow label={label} path={writePath} fallback={value} mode={modeButton} />;
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
            value={String(value ?? fallback)}
            options={row.values.map((v) => ({
              value: v,
              label: choiceLabel(t, key, v),
              sub: row.subs?.includes(v)
                ? t(`style_editor.value_${key.replace(/\./g, "_")}_${v}_sub`)
                : undefined,
              icon: choiceGlyph(key, v),
            }))}
            onChange={(next) => store.set(writePath, next)}
            mode={modeButton}
            note={note}
          />
        );
    }
  }
});
