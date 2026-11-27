"use client";

// The classes of a classification (prototype 4.5 class list): per class its value for the target (a color, a number,
// a choice or an icon), the lower bound of manual breaks, the name with the automatic label as placeholder, the
// feature count, show or hide, and "Style this class"; then Other and No data. A category class's label opens its
// values to pick, "Add class" starts a new one, and a category class dragged onto another moves there. The rows share
// one grid (`ClassGrid`, a raster's classes use it too), so values, labels and counts line up in columns; a number
// column keeps room for its longest value, as a slider's value does.
import { Box, ButtonBase, IconButton, InputBase, Tooltip, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { checkered } from "@/lib/style/checker";
import type { Geometry } from "@/lib/style/compile/types";
import {
  addCategoryClass,
  classPaletteColors,
  moveClass,
  removeClass,
  setManualBound,
} from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import { compoundOf, fixedChoice, writeCompound } from "@/lib/style/editor/forms";
import { formatNumberText } from "@/lib/style/editor/labels";
import { type Path, getIn } from "@/lib/style/editor/store";
import { HATCH, choiceLabel, compoundOptions, plainNumber, swatchOf } from "@/lib/style/editor/summaries";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import {
  classDomain,
  classFormat,
  classRange,
  labelRange,
  rangeText,
  singleValue,
  valuesText,
} from "@/lib/style/legend";

import {
  useBasemapTone,
  useEditor,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import {
  CATEGORY_GRAY,
  ClassGrid,
  ClassGridRow,
  FOCUS_MARK,
} from "@/components/map/panels/styleEditor/editors/ClassGrid";
import { ClassValues } from "@/components/map/panels/styleEditor/editors/ClassValues";
import { PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { PathIconPicker } from "@/components/map/panels/styleEditor/editors/IconRow";
import { useShapeState } from "@/components/map/panels/styleEditor/editors/ShapeField";
import { GROUPS, PATTERNS, rowChoices } from "@/components/map/panels/styleEditor/editors/partRows";
import { IconGlyph } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
import { PatternPicture, PatternTiles } from "@/components/map/panels/styleEditor/pickers/PatternTiles";
import { MarkerPicture } from "@/components/map/panels/styleEditor/pickers/ShapeTiles";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { AddButton, ChoiceField, NumberInput } from "@/components/map/panels/styleEditor/rows";
import { valueChars } from "@/components/map/panels/styleEditor/rows/SliderRow";

type RecordKey = number | "other" | "no_data";

/** The label of the panel's row that sets `target` ("Size", "Color"), short enough for the head of the value column. */
function rowLabelKey(target: string, geometry?: Geometry): string | undefined {
  for (const group of geometry ? GROUPS[geometry] : [])
    for (const row of [group.inline, ...group.rows])
      if (row && `${group.part}.${row.key}` === target) return row.label;
  return undefined;
}

/** A number as its box shows it (two decimals at most, a percent as 0 to 100), in the panel's language. */
const numberText = (value: number, pct?: boolean, language = "en") =>
  plainNumber(pct ? value * 100 : value, language);

/** The characters a column of numbers keeps room for: the longest end of the property's range (as a slider's value
 * does), or a longer value in the column. */
export function columnChars(values: unknown[], target?: string): number {
  const range = target ? SLIDERS[target] : undefined;
  const numbers = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return Math.max(
    range ? valueChars(range.min, range.max, range.step, range.pct) : 1,
    ...numbers.map((v) => numberText(v, range?.pct).length)
  );
}

interface ClassRowProps {
  ci: number;
  record: RecordKey;
  target: string;
  /** The automatic label: the name's placeholder. */
  label: string;
  /** The class's whole range when the label shows only its rest (manual breaks): the title of its pickers. */
  range?: string;
  count?: number;
  /** Manual breaks: the list has a column of lower bounds, editable from the second class on. */
  bounds?: boolean;
  /** The characters the value and bound columns keep room for. */
  reserve: { value: number; bound: number };
  /** The values a choice target takes. */
  choices?: readonly string[];
  /** A category class: its label opens its values; the id of its classification finds it again. */
  values?: { classificationId?: string };
  /** Other or No data the data holds no feature for: the row stands back; its look waits for data that has some. */
  absent?: boolean;
}

/** Opens the values of class `k` of `classify[ci]` beside the control `anchor`, with "Remove class". */
function useValuesOpener() {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  return (anchor: HTMLElement, ci: number, k: number, classificationId?: string) => {
    const record = store.get(`classify.${ci}.classes.${k}`);
    const rec = (isObject(record) ? record : {}) as JsonObject;
    const classId = typeof rec.id === "string" ? rec.id : undefined;
    const title =
      typeof rec.name === "string" && rec.name ? rec.name : t("style_editor.class_n", { n: k + 1 });
    popover.open("picker", {
      key: `class-values:${classificationId ?? ci}:${classId ?? k}`,
      title,
      anchorTop: anchorTopOf(anchor),
      anchorEl: anchor,
      render: () => <ClassValues ci={ci} k={k} classificationId={classificationId} classId={classId} />,
      onDelete: {
        label: t("style_editor.remove_class"),
        onClick: () => {
          const classes = store.get(`classify.${ci}.classes`);
          const now = Array.isArray(classes)
            ? classes.findIndex((r) => isObject(r) && classId !== undefined && r.id === classId)
            : -1;
          store.update((doc) => removeClass(doc, ci, now >= 0 ? now : k));
          popover.close("picker");
        },
      },
    });
  };
}

/** A class's pattern: the tiles, writing into the class's record. */
function ClassPatternPicker({ path, choices }: { path: Path; choices?: readonly string[] }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const value = useStyleValue<unknown>(path);
  return (
    <PatternTiles
      label={t("style_editor.pattern")}
      values={choices ?? PATTERNS}
      value={typeof value === "string" ? value : "none"}
      onChange={(next) => store.set(path, next)}
    />
  );
}

function TargetValue({
  path,
  target,
  title,
  choices,
  reserve,
}: {
  path: Path;
  target: string;
  title: string;
  choices?: readonly string[];
  reserve: number;
}) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const { geometry } = useStyleData();
  const tone = useBasemapTone();
  const valuePath = `${path}.${target}`;
  const value = useStyleValue<unknown>(valuePath);
  // A compound target (the label's Font) reads every key of its part.
  const compound = compoundOf(target);
  const part = useStyleValue<unknown>(`${path}.${target.split(".")[0]}`);
  const layerPart = useStyleValue<unknown>(`symbol.${target.split(".")[0]}`);
  const look = useShapeState(`${path}.marker`);
  // A record without a value draws with the layer's own (the cascade falls back to it): its box shows that value.
  const layerValue = useStyleValue<unknown>(`symbol.${target}`);
  const kind = CAPABILITIES[target]?.kind;
  if (target === "marker.icon") {
    return (
      <ButtonBase
        aria-label={t("style_editor.class_icon")}
        onClick={(event) =>
          popover.open("picker", {
            key: `class-icon:${valuePath}`,
            title,
            anchorTop: anchorTopOf(event.currentTarget),
            anchorEl: event.currentTarget,
            // The class's icon, with the layer's shape.
            render: () => <PathIconPicker path={valuePath} />,
          })
        }
        sx={{
          width: 20,
          height: 20,
          flex: "none",
          borderRadius: 0.5,
          border: look.shape === "icon" ? 1 : 0,
          borderColor: "divider",
          background: typeof value === "string" ? undefined : HATCH,
          ...FOCUS_MARK,
        }}>
        {/* The class's marker: its icon in its shape, or the icon alone. */}
        {typeof value === "string" &&
          (look.shape === "icon" ? (
            <IconGlyph iconRef={value} size={14} />
          ) : (
            <MarkerPicture shape={look.shape} size={20} preview={{ ...look.preview, icon: value }} />
          ))}
      </ButtonBase>
    );
  }
  if (target === "fill.pattern") {
    // The class's pattern as its picture, picked from the pattern tiles as the base's is.
    const pattern = typeof value === "string" ? value : undefined;
    return (
      <ButtonBase
        aria-label={t("style_editor.class_pattern")}
        title={pattern ? choiceLabel(t, target, pattern) : undefined}
        onClick={(event) =>
          popover.open("picker", {
            key: `class-pattern:${valuePath}`,
            title,
            anchorTop: anchorTopOf(event.currentTarget),
            anchorEl: event.currentTarget,
            render: () => <ClassPatternPicker path={valuePath} choices={choices} />,
          })
        }
        sx={{
          width: 20,
          height: 20,
          flex: "none",
          borderRadius: 0.5,
          border: 1,
          borderColor: "divider",
          color: "text.primary",
          background: pattern === undefined ? HATCH : undefined,
          ...FOCUS_MARK,
        }}>
        {pattern && pattern !== "none" && <PatternPicture kind={pattern} size={14} />}
      </ButtonBase>
    );
  }
  if (kind === "color")
    return (
      <ButtonBase
        aria-label={t("style_editor.class_color")}
        onClick={(event) =>
          popover.open("picker", {
            key: `class-color:${valuePath}`,
            title,
            anchorTop: anchorTopOf(event.currentTarget),
            anchorEl: event.currentTarget,
            // The choices of the target's row (Auto, None, Same as fill on an outline), without the one that unsets
            // the key: unset, a class draws the layer's own color, not the part it would follow.
            render: () => (
              <PathColorPicker
                path={valuePath}
                sentinels={
                  geometry
                    ? rowChoices(geometry, target).filter((c) => c.none || c.value !== undefined)
                    : undefined
                }
                write={(hex) => store.set(valuePath, hex)}
              />
            ),
          })
        }
        sx={{
          width: 20,
          height: 20,
          flex: "none",
          borderRadius: 0.5,
          border: 1,
          borderColor: "divider",
          // A color the class derives ("Auto", "Same as fill") shows as the map draws it.
          background:
            typeof value === "string"
              ? checkered(swatchOf(store.document, valuePath, geometry, { scoped: true, tone }))
              : HATCH,
          ...FOCUS_MARK,
        }}
      />
    );
  if (kind === "number") {
    const slider = SLIDERS[target];
    const inherited = layerValue === undefined ? DEFAULTS[target] : layerValue;
    return (
      <NumberInput
        value={typeof value === "number" ? value : undefined}
        unit={slider?.unit}
        pct={slider?.pct}
        plain
        reserve={reserve}
        placeholder={
          typeof inherited === "number" ? numberText(inherited, slider?.pct, i18n.language) : undefined
        }
        ariaLabel={t("style_editor.class_value")}
        onChange={(v) => store.set(valuePath, v)}
      />
    );
  }
  // The Font: a weight, upright or italic, both keys written, so the class draws its font whatever the layer's. Without
  // one of its own the class draws the layer's font: shown while it is one font, none while it varies by zoom.
  if (compound) {
    const own = isObject(part) && compound.keys.some((key) => getIn(part, key) !== undefined);
    return (
      <ChoiceField<string>
        ariaLabel={title}
        value={own ? compound.read(part) : (fixedChoice(compound, layerPart) ?? "")}
        options={compoundOptions(t, compound)}
        onChange={(v) =>
          store.update((doc) => writeCompound(doc, compound, `${path}.${compound.part}`, v, true))
        }
        sx={{ height: 28 }}
      />
    );
  }
  // A field of its own, as the panel's other choices, at the height of the class rows.
  return (
    <ChoiceField<string>
      ariaLabel={title}
      value={typeof value === "string" ? value : ""}
      options={(choices ?? []).map((v) => ({ value: v, label: choiceLabel(t, target, v) }))}
      onChange={(v) => store.set(valuePath, v)}
      sx={{ height: 28 }}
    />
  );
}

function ClassRow({
  ci,
  record,
  target,
  label,
  range,
  count,
  bounds,
  reserve,
  choices,
  values,
  absent,
}: ClassRowProps) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const openValues = useValuesOpener();
  const path = typeof record === "number" ? `classify.${ci}.classes.${record}` : `classify.${ci}.${record}`;
  const value = useStyleValue<unknown>(path);
  const rec = (isObject(value) ? value : {}) as JsonObject;
  const name = typeof rec.name === "string" ? rec.name : "";
  const hidden = rec.visible === false;
  const bound = bounds && typeof record === "number" && record > 0;
  return (
    <ClassGridRow
      // A category class can be dragged to another's place or moved with Alt and an arrow (the grid's reorder); Other
      // and No data stay last.
      index={values && typeof record === "number" ? record : undefined}
      absent={absent}
      title={absent ? t("style_editor.none_in_data") : undefined}
      hidden={hidden}
      onToggle={() => store.set(`${path}.visible`, hidden ? undefined : false)}
      swatch={
        <TargetValue
          // Its pickers write to the class at this place: drawn anew at another place (a class dragged), the open
          // picker closes.
          key={path}
          path={path}
          target={target}
          title={name || range || label}
          choices={choices}
          reserve={reserve.value}
        />
      }
      // Manual breaks: a class after the first starts at its bound, typed in front of the rest of its range; the
      // first class, Other and No data have no bound, their label takes the bound's column too.
      bound={
        bound ? (
          <NumberInput
            value={typeof rec.from === "number" ? rec.from : undefined}
            plain
            reserve={reserve.bound}
            ariaLabel={t("style_editor.lower_bound")}
            onChange={(v) => store.update((doc) => setManualBound(doc, ci, record, v), `${path}.from`)}
          />
        ) : undefined
      }
      label={
        values && typeof record === "number" ? (
          <ButtonBase
            aria-haspopup="dialog"
            title={name || label || undefined}
            onClick={(event) => openValues(event.currentTarget, ci, record, values.classificationId)}
            sx={{
              minWidth: 0,
              height: 28,
              mx: -1,
              px: 1,
              borderRadius: 1,
              justifyContent: "flex-start",
              "&:hover": { bgcolor: "action.hover" },
              ...FOCUS_MARK,
            }}>
            <Typography
              variant="body2"
              noWrap
              sx={name || label ? undefined : { color: "primary.main", fontStyle: "italic" }}>
              {name || label || t("style_editor.pick_values")}
            </Typography>
          </ButtonBase>
        ) : (
          <InputBase
            value={name}
            placeholder={label}
            inputProps={{ "aria-label": t("style_editor.class_name") }}
            onChange={(event) => store.set(`${path}.name`, event.target.value || undefined)}
            sx={{ minWidth: 0, typography: "body2", "& input": { p: 0 } }}
          />
        )
      }
      count={count !== undefined ? formatNumberText(count, {}, i18n.language) : undefined}
      style={
        // No data is styled like a class once it has a record of its own.
        record === "no_data" && !isObject(value) ? undefined : (
          <Tooltip title={t("style_editor.style_this_class")}>
            <IconButton
              size="small"
              aria-label={t("style_editor.style_this_class")}
              onClick={() => {
                store.setScope({ classify: ci, key: record });
                popover.close(1);
              }}>
              <Icon iconName={ICON_NAME.EDIT} sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        )
      }
    />
  );
}

/** How range labels are written: the words, the locale, a unit and number format, the data's ends. */
export type RangeOptions = Parameters<typeof rangeText>[1];

/** The legend's words for ranges. */
export const rangeWords = (t: (key: string) => string): RangeOptions["words"] => ({
  under: t("style_editor.range_under"),
  to: t("style_editor.range_to"),
  andMore: t("style_editor.range_and_more"),
});

/** The legend's range words, unit and number format of classification `c`, and the data's minimum and maximum the
 * server computed with it, which its open classes read (as the legend does). */
const rangeOptions = (c: JsonObject, t: (key: string) => string, locale: string): RangeOptions => ({
  locale,
  words: rangeWords(t),
  unit: typeof c.unit === "string" ? c.unit : undefined,
  format: classFormat(c),
  domain: classDomain(c),
});

/** A class's legend text: its name, else the automatic label (its values, or its range, with the classification's
 * unit), as the legend writes it. */
export function classLabel(
  c: JsonObject,
  record: JsonObject,
  t: (key: string) => string,
  locale: string
): string {
  if (typeof record.name === "string" && record.name) return record.name;
  if (Array.isArray(record.values))
    return valuesText(record.values as Array<string | number | boolean>, rangeOptions(c, t, locale));
  return rangeText(classRange(c, record), rangeOptions(c, t, locale));
}

/** The range of a manual class after its typed bound: "to 14.81"; for the last class "to" the data's maximum, else
 * "and more". */
export function rangeAfterBound(record: JsonObject, options: RangeOptions, t: (key: string) => string) {
  // The last class runs to the data's maximum where that reads as a range.
  const to =
    typeof record.to === "number"
      ? record.to
      : typeof record.from === "number"
        ? labelRange({ from: record.from }, options).to
        : undefined;
  if (to === undefined) return t("style_editor.range_and_more");
  // "Under" with the word "to": the end of the range as the legend writes it, with its format and unit.
  return rangeText(
    { to },
    { ...options, domain: undefined, words: { ...options.words, under: options.words.to } }
  );
}

export interface ClassListProps {
  ci: number;
  c: JsonObject;
  target: string;
  choices?: readonly string[];
  /** Feature counts per class, Other and No data when known. */
  counts?: { classes?: Array<number | undefined>; other?: number; noData?: number };
  /** Other shows without a record of its own: some values are in no class. */
  showOther?: boolean;
  /** Other and No data the data holds no feature for (the legend leaves those out): their rows stand back. */
  absent?: { other?: boolean; noData?: boolean };
  /** The palette new classes take their colors from. */
  palette?: string | string[];
  /** The name of the property the classes set, over their values when the panel has no shorter row label for it. */
  valueLabel: string;
}

/** A record holding `value` at the dotted `key` ("marker.color" is `{ marker: { color } }`). */
const recordWith = (key: string, value: unknown): JsonObject =>
  key.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value) as JsonObject;

/** "Add class": a new category class with the first palette color no class has, its values open to pick. The colors are
 * the ones as many classes as there are then get from the palette (reversed where they are), so the new color is one
 * the palette picker's strip shows for that count. */
function AddClassButton({
  ci,
  c,
  target,
  palette,
}: {
  ci: number;
  c: JsonObject;
  target: string;
  palette: string | string[];
}) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const openValues = useValuesOpener();
  const add = (anchor: HTMLElement) => {
    const classes = (Array.isArray(c.classes) ? c.classes : []).filter(isObject);
    let record: JsonObject = {};
    if (CAPABILITIES[target]?.kind === "color") {
      const used = new Set(classes.map((k) => String(getIn(k, target)).toLowerCase()));
      const colors = classPaletteColors(c, palette, classes.length + 1);
      record = recordWith(target, colors.find((color) => !used.has(color)) ?? CATEGORY_GRAY);
    }
    store.update((doc) => addCategoryClass(doc, ci, record));
    openValues(anchor, ci, classes.length, typeof c.id === "string" ? c.id : undefined);
  };
  return (
    <AddButton onClick={(event) => add(event.currentTarget)} sx={{ mt: 1, ml: 2 }}>
      {t("style_editor.add_class")}
    </AddButton>
  );
}

export function ClassList({
  ci,
  c,
  target,
  choices,
  counts,
  showOther,
  absent,
  palette,
  valueLabel,
}: ClassListProps) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const { geometry, fields } = useStyleData();
  const classes = (Array.isArray(c.classes) ? c.classes : []).filter(isObject);
  // The placeholder is the automatic label, so a name typed by hand does not hide it.
  const auto = (record: JsonObject) => classLabel(c, { ...record, name: undefined }, t, i18n.language);
  const showNoData = isObject(c.no_data) || (counts?.noData ?? 0) > 0;
  const categories = c.method === "categories";
  const values = categories ? { classificationId: typeof c.id === "string" ? c.id : undefined } : undefined;
  const bounds = c.method === "manual";
  const records = [...classes, c.other, c.no_data].filter(isObject);
  const reserve = {
    value: columnChars(
      records.map((r) => getIn(r, target)),
      target
    ),
    bound: columnChars(classes.slice(1).map((r) => r.from)),
  };
  const rowLabel = rowLabelKey(target, geometry);
  const fieldName = typeof c.field === "string" ? c.field : "";
  const fieldLabel = fields.find((f) => f.name === fieldName)?.label ?? fieldName;
  return (
    <Box sx={{ py: 1 }}>
      <ClassGrid
        head={{
          value: rowLabel ? t(rowLabel) : valueLabel,
          label: fieldLabel,
          count: t("features"),
          // Over the numbers at their end, over swatches and choices at their start.
          valueAlign: CAPABILITIES[target]?.kind === "number" ? "end" : "start",
        }}
        bounds={bounds}
        rows={classes.length}
        onReorder={
          categories
            ? (from, to) => {
                store.update((doc) => moveClass(doc, ci, from, to));
                // A class without an id has its values open by its place in the list: they close.
                if (classes.some((r) => typeof r.id !== "string")) popover.close("picker");
              }
            : undefined
        }>
        {classes.map((record, i) => (
          <ClassRow
            key={typeof record.id === "string" ? record.id : i}
            ci={ci}
            record={i}
            target={target}
            label={
              // After a typed bound the rest of the range, or the one value the class holds, as the legend reads it.
              bounds && i > 0 && singleValue(c, record) === undefined
                ? rangeAfterBound(record, rangeOptions(c, t, i18n.language), t)
                : auto(record)
            }
            range={auto(record)}
            count={counts?.classes?.[i]}
            bounds={bounds}
            reserve={reserve}
            choices={choices}
            values={values}
          />
        ))}
        {(isObject(c.other) || showOther) && (
          <ClassRow
            ci={ci}
            record="other"
            target={target}
            label={t("style_editor.other")}
            count={counts?.other}
            absent={absent?.other}
            bounds={bounds}
            reserve={reserve}
            choices={choices}
          />
        )}
        {showNoData && (
          <ClassRow
            ci={ci}
            record="no_data"
            target={target}
            label={t("style_editor.no_data")}
            count={counts?.noData}
            absent={absent?.noData}
            bounds={bounds}
            reserve={reserve}
            choices={choices}
          />
        )}
      </ClassGrid>
      {categories && <AddClassButton ci={ci} c={c} target={target} palette={palette ?? "colorbrewer:Set2"} />}
    </Box>
  );
}
