"use client";

// The symbol section ("Polygons", "Lines", "Points"): one row per group with a swatch and a summary that opens the
// group's editor in level 1; point Size is its slider row right here.
import { Box, Button, Typography } from "@mui/material";
import { type ReactNode, memo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { classifyShape, recordPathOf, scopedView } from "@/lib/style/editor/classify";
import { MAIN_COLOR, modeOf, targetsOf } from "@/lib/style/editor/forms";
import { templateField } from "@/lib/style/editor/labels";
import { markerFilled, partOn, symbolShown } from "@/lib/style/editor/parts";
import { getIn, isRuleScope, setIn } from "@/lib/style/editor/store";
import { HATCH, choiceLabel, summarize, swatchOf } from "@/lib/style/editor/summaries";
import { type JsonObject, isObject } from "@/lib/style/json";
import { markerShapeOf } from "@/lib/style/markerShapes";

import ToolPill from "@/components/dashboard/common/ToolPill";
import { useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useEditor,
  useLiveMapZoom,
  useMapZoom,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { classLabel } from "@/components/map/panels/styleEditor/editors/ClassList";
import {
  IconSwitch,
  PartEditor,
  PartSwitch,
  markerInvisible,
  partPath,
} from "@/components/map/panels/styleEditor/editors/PartEditor";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import { useRuleLabel } from "@/components/map/panels/styleEditor/editors/RuleEditor";
import { ShapedIcon } from "@/components/map/panels/styleEditor/editors/ShapeField";
import { GROUPS, type PartGroup } from "@/components/map/panels/styleEditor/editors/partRows";
import { IconStops } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
import { useIconLabel } from "@/components/map/panels/styleEditor/pickers/iconRefs";
import { type DropdownItem, DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  GroupRow,
  MAX_ZOOM,
  PanelSection,
  SwatchBox,
  ZoomRangeRow,
} from "@/components/map/panels/styleEditor/rows";

const PartGroupRow = memo(function PartGroupRow({ group }: { group: PartGroup }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const mapZoom = useMapZoom();
  const popover = usePopover();
  const base = partPath(group);
  // In class scope the row summarizes the class: its part merged over the base, a dot when it sets anything.
  const { value, overridden } = useScoped(base);
  const scope = useScope();
  // The summary reads the classifications (a color by classes) and the main color ("Same as fill").
  const geometry = data.geometry ?? "polygon";
  useStyleSelector((doc) => classifyShape(doc, data.geometry));
  useStyleValue(`symbol.${MAIN_COLOR[geometry]}`);
  // The points' Fill is off on a hollow marker, while the marker itself is drawn.
  const on = partOn(value, group.part, geometry) && (!group.switchKey || markerFilled(value));
  const label = t(`style_editor.part_${group.id}`);
  // Groups that share a part (point fill, outline, icon) each show the issues of their own keys.
  const issues = useIssueAt(
    group.rows.length ? [...group.rows.map((row) => `${base}.${row.key}`), `${base}.${group.summary}`] : base
  );
  const doc = scope ? scopedView(store.document, scope).view : store.document;
  // A hollow marker without outline or icon draws nothing: the Fill row warns, as the editor does.
  const invisible = group.switchKey !== undefined && markerInvisible(store.document, scope);
  const summaryPath = `${base}.${group.summary}`;
  const iconName = useIconLabel(group.summary === "icon" ? getIn(doc, summaryPath) : undefined);
  let text = on
    ? summarize(doc, summaryPath, t, { fields: data.fields, mapZoom, geometry })
    : t("style_editor.none");
  const swatch =
    on && group.swatch
      ? swatchOf(doc, `${base}.${group.swatch}`, geometry, { scoped: scope !== null })
      : undefined;
  if (on && group.summary === "text") {
    // The field's display name or the template, and the size: "Name · 12 px".
    const template = getIn(doc, summaryPath);
    const field = typeof template === "string" ? templateField(template) : null;
    const name =
      field !== null
        ? (data.fields.find((f) => f.name === field)?.label ?? field)
        : typeof template === "string" && template
          ? template.replace(/\n/g, " ")
          : t("style_editor.no_text");
    text = `${name} · ${summarize(doc, `${base}.size`, t, { fields: data.fields, mapZoom, geometry })}`;
  }
  let glyph: ReactNode;
  let iconValue: ReactNode;
  if (on && group.summary === "icon") {
    // A fixed icon shows itself in its shape and its name (an emoji only itself), icons by zoom only themselves, icons
    // by classes their field. The shape shows in the pictures, as in the Icon editor.
    const icon = getIn(doc, summaryPath);
    const raw = getIn(doc, `${base}.shape`);
    const shape = markerShapeOf(raw);
    const iconMode = modeOf(doc, summaryPath, geometry);
    // Without an icon a circle is the plain marker; any other shape names itself.
    if (icon === undefined && iconMode === "fixed")
      text =
        shape === "circle" || raw === "icon" ? t("style_editor.none") : choiceLabel(t, "marker.shape", shape);
    else if (iconMode === "fixed" && typeof icon === "string") {
      glyph = <ShapedIcon iconRef={icon} size={16} record={base} />;
      text = icon.startsWith("emoji:") ? "" : iconName(icon);
    } else if (iconMode === "zoom")
      iconValue = (
        <IconStops
          value={icon}
          name={iconName}
          renderIcon={(ref, size) => <ShapedIcon iconRef={ref} size={size} record={base} />}
        />
      );
  }
  return (
    <GroupRow
      label={label}
      off={!on}
      overrideDot={overridden}
      warn={issues[0]?.message ?? (invisible ? t("style_editor.marker_invisible") : undefined)}
      value={iconValue ?? text}
      glyph={glyph}
      swatch={swatch ? { background: swatch, wide: swatch.startsWith("linear-gradient") } : undefined}
      onOpen={(anchor) =>
        popover.open(1, {
          key: `part:${group.id}`,
          title: label,
          anchorTop: anchorTopOf(anchor),
          render: () => <PartEditor part={group.id} />,
          actions: group.toggle ? (
            <PartSwitch part={group.id} />
          ) : group.id === "icon" ? (
            <IconSwitch />
          ) : undefined,
        })
      }
    />
  );
});

/** "All features" or the scoped class with its swatch; opens the menu of classes to style one on its own. */
function ScopeChip() {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const scope = useScope();
  useStyleSelector((doc) => classifyShape(doc, geometry));
  const ruleLabel = useRuleLabel();
  const all = store.get("classify");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pill = useRef<HTMLButtonElement | null>(null);
  const classify = (Array.isArray(all) ? all : []).filter(isObject);
  const ruleScope = isRuleScope(scope) ? scope : null;
  const classScope = scope && !isRuleScope(scope) ? scope : null;
  if (!ruleScope && !classify.some((c) => Array.isArray(c.classes) && c.classes.length)) return null;
  const swatchOfRecord = (c: JsonObject, record: unknown) => {
    const color = isObject(record) ? getIn(record, targetsOf(c, geometry)[0]) : undefined;
    return typeof color === "string" ? color : HATCH;
  };
  const items: DropdownItem[] = [
    { label: t("style_editor.all_features"), selected: scope === null, onClick: () => store.setScope(null) },
  ];
  classify.forEach((c, ci) => {
    items.push({ label: typeof c.title === "string" ? c.title : String(c.field), heading: true });
    (Array.isArray(c.classes) ? c.classes : []).filter(isObject).forEach((record, k) =>
      items.push({
        label: classLabel(c, record, t, i18n.language),
        swatch: swatchOfRecord(c, record),
        selected: classScope?.classify === ci && classScope.key === k,
        onClick: () => store.setScope({ classify: ci, key: k }),
      })
    );
    if (isObject(c.other))
      items.push({
        label: classLabel(
          c,
          { ...c.other, values: undefined, name: c.other.name ?? t("style_editor.other") },
          t,
          i18n.language
        ),
        swatch: swatchOfRecord(c, c.other),
        selected: classScope?.classify === ci && classScope.key === "other",
        onClick: () => store.setScope({ classify: ci, key: "other" }),
      });
  });
  const current = classScope ? classify[classScope.classify] : undefined;
  const record = current && classScope ? getIn(store.document, recordPathOf(classScope)) : undefined;
  const chipLabel = ruleScope
    ? ruleLabel(store.get(`rules.${ruleScope.index}`))
    : current && isObject(record)
      ? classLabel(
          current,
          classScope?.key === "other" && !record.name ? { name: t("style_editor.other") } : record,
          t,
          i18n.language
        )
      : t("style_editor.all_features");
  return (
    <>
      <ToolPill
        small
        flat
        chevron
        ariaLabel={`${t("style_editor.style_one_class")}: ${chipLabel}`}
        popup={{ kind: "menu", open: !!anchor }}
        active={!!anchor || scope !== null}
        label={chipLabel}
        start={
          current ? (
            <SwatchBox swatch={{ background: swatchOfRecord(current, record), small: true }} />
          ) : undefined
        }
        onClick={() => setAnchor(anchor ? null : pill.current)}
        ref={pill}
      />
      <DropdownMenu
        anchorEl={anchor}
        title={t("style_editor.style_one_class")}
        items={items}
        hint={t(`style_editor.scope_hint_${geometry ?? "polygon"}`)}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}

/** The scoped class's own zoom range (spec 5.5): the class record's `min_zoom` and `max_zoom`, inside the layer's. */
function ScopeZooms() {
  const store = useEditor();
  const scope = useScope();
  const mapZoom = useLiveMapZoom();
  const record = scope ? recordPathOf(scope) : "";
  const from = useStyleValue<number | undefined>(`${record}.min_zoom`);
  const until = useStyleValue<number | undefined>(`${record}.max_zoom`);
  const layerFrom = useStyleValue<number | undefined>("min_zoom");
  const layerUntil = useStyleValue<number | undefined>("max_zoom");
  if (!scope) return null;
  return (
    <ZoomRangeRow
      from={from}
      until={until}
      mapZoom={mapZoom}
      layerRange={[layerFrom ?? 0, layerUntil ?? MAX_ZOOM]}
      onChange={(min, max) =>
        store.update(
          (doc) => setIn(setIn(doc, `${record}.min_zoom`, min), `${record}.max_zoom`, max),
          `${record}.zooms`
        )
      }
    />
  );
}

/** "Editing {class} only." with a way back to all features. */
function ScopeNote() {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const scope = useScope();
  const { geometry } = useStyleData();
  useStyleSelector((doc) => classifyShape(doc, geometry));
  const ruleLabel = useRuleLabel();
  // The scoped rule's name only, so a color drag in rule scope does not render the note.
  const ruleName = useStyleSelector((doc) =>
    scope && isRuleScope(scope) ? ruleLabel(getIn(doc, recordPathOf(scope))) : ""
  );
  if (!scope) return null;
  const record = getIn(store.document, recordPathOf(scope));
  if (!isObject(record)) return null;
  let name: string;
  if (isRuleScope(scope)) name = ruleName;
  else {
    const c = getIn(store.document, `classify.${scope.classify}`);
    if (!isObject(c)) return null;
    name =
      scope.key === "other" && !record.name
        ? t("style_editor.other")
        : classLabel(c, record, t, i18n.language);
  }
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
        {t("style_editor.scope_note", { class: name })}
      </Typography>
      <Button size="small" onClick={() => store.setScope(null)} sx={{ textTransform: "none" }}>
        {t("style_editor.all_features")}
      </Button>
    </Box>
  );
}

function ScopeHeader() {
  return (
    <>
      <ScopeNote />
      <ScopeZooms />
    </>
  );
}

export function SymbolSection() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { geometry } = useStyleData();
  const scope = useScope();
  useStyleValue("render");
  // What is not drawn is not shown: a heatmap without points hides the symbol.
  if (!geometry || !symbolShown(store.document)) return null;
  return (
    <PanelSection
      title={t(`style_editor.geometry_${geometry}`)}
      scope={<ScopeChip />}
      scopeNote={scope ? <ScopeHeader /> : undefined}>
      {GROUPS[geometry].map((group) =>
        group.inline ? (
          <PropertyRow key={group.id} row={group.inline} base={partPath(group)} />
        ) : (
          <PartGroupRow key={group.id} group={group} />
        )
      )}
    </PanelSection>
  );
}
