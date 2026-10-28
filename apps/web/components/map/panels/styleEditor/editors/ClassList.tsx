"use client";

// The classes of a classification (prototype 4.5 class list): per class its value for the target (a color, a number,
// a choice or an icon), the lower bound of manual breaks, the name with the automatic label as placeholder, the
// feature count, show or hide, and "Style this class"; then Other and No data. A category class's label opens its
// values to pick, and "Add class" starts a new one. The rows share one grid, so values, labels and counts line up in
// columns; a number column keeps room for its longest value, as a slider's value does.
import { Box, Button, ButtonBase, IconButton, InputBase, Tooltip, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { Geometry } from "@/lib/style/compile/types";
import { addCategoryClass, removeClass, setManualBound } from "@/lib/style/editor/classify";
import { SLIDERS } from "@/lib/style/editor/defaults";
import { formatNumberText } from "@/lib/style/editor/labels";
import { type Path, getIn } from "@/lib/style/editor/store";
import { HATCH, choiceLabel } from "@/lib/style/editor/summaries";
import { CAPABILITIES } from "@/lib/style/generated/capabilities";
import { DEFAULTS } from "@/lib/style/generated/defaults";
import { type JsonObject, isObject } from "@/lib/style/json";
import { type RangeFormat, classDomain, labelRange, rangeText, valuesText } from "@/lib/style/legend";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { CATEGORY_GRAY } from "@/components/map/panels/styleEditor/editors/CategoriesEditor";
import { ClassValues } from "@/components/map/panels/styleEditor/editors/ClassValues";
import { PathColorPicker } from "@/components/map/panels/styleEditor/editors/ColorRow";
import { PathIconPicker } from "@/components/map/panels/styleEditor/editors/IconRow";
import { useShapeState } from "@/components/map/panels/styleEditor/editors/ShapeField";
import { GROUPS, PATTERNS } from "@/components/map/panels/styleEditor/editors/partRows";
import { IconGlyph } from "@/components/map/panels/styleEditor/pickers/IconGlyph";
import { paletteColors } from "@/components/map/panels/styleEditor/pickers/PalettePicker";
import { PatternPicture, PatternTiles } from "@/components/map/panels/styleEditor/pickers/PatternTiles";
import { MarkerPicture } from "@/components/map/panels/styleEditor/pickers/ShapeTiles";
import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import { NumberInput } from "@/components/map/panels/styleEditor/rows";
import { valueChars } from "@/components/map/panels/styleEditor/rows/SliderRow";

type RecordKey = number | "other" | "no_data";

/** The line between what the classes set and the field's values they cover. */
const Rule = () => <Box aria-hidden sx={{ alignSelf: "stretch", width: "1px", bgcolor: "divider" }} />;

/** The label of the panel's row that sets `target` ("Size", "Color"), short enough for the head of the value column. */
function rowLabelKey(target: string, geometry?: Geometry): string | undefined {
  for (const group of geometry ? GROUPS[geometry] : [])
    for (const row of [group.inline, ...group.rows])
      if (row && `${group.part}.${row.key}` === target) return row.label;
  return undefined;
}

/** A number as its box shows it (two decimals at most, a percent as 0 to 100). */
const numberText = (value: number, pct?: boolean) => String(Number((pct ? value * 100 : value).toFixed(2)));

/** The characters a column of numbers keeps room for: the longest end of the property's range (as a slider's value
 * does), or a longer value in the column. */
function columnChars(values: unknown[], target?: string): number {
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
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const valuePath = `${path}.${target}`;
  const value = useStyleValue<unknown>(valuePath);
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
            render: () => <PathColorPicker path={valuePath} write={(hex) => store.set(valuePath, hex)} />,
          })
        }
        sx={{
          width: 20,
          height: 20,
          flex: "none",
          borderRadius: 0.5,
          border: 1,
          borderColor: "divider",
          background: typeof value === "string" ? value : HATCH,
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
        placeholder={typeof inherited === "number" ? numberText(inherited, slider?.pct) : undefined}
        ariaLabel={t("style_editor.class_value")}
        onChange={(v) => store.set(valuePath, v)}
      />
    );
  }
  return (
    <>
      <Button
        size="small"
        color="inherit"
        onClick={(event) => setMenu(menu ? null : event.currentTarget)}
        sx={{ textTransform: "none", minWidth: 0, px: 1 }}>
        {value === undefined ? "…" : choiceLabel(t, target, value)}
      </Button>
      <DropdownMenu
        anchorEl={menu}
        title={title}
        items={(choices ?? []).map((v) => ({
          label: choiceLabel(t, target, v),
          selected: v === value,
          onClick: () => store.set(valuePath, v),
        }))}
        onClose={() => setMenu(null)}
      />
    </>
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
  const labelColumn = bounds && !bound ? { gridColumn: "span 2" } : undefined;
  return (
    // A row of the list's grid: every cell sits in its column, an empty one where the row has nothing there.
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "subgrid",
        gridColumn: "1 / -1",
        alignItems: "center",
        minHeight: 32,
        opacity: hidden ? 0.55 : 1,
      }}>
      <TargetValue
        path={path}
        target={target}
        title={name || range || label}
        choices={choices}
        reserve={reserve.value}
      />
      <Rule />
      {/* Manual breaks: a class after the first starts at its bound, typed in front of the rest of its range; the
          first class, Other and No data have no bound, their label takes the bound's column too. */}
      {bound ? (
        <NumberInput
          value={typeof rec.from === "number" ? rec.from : undefined}
          plain
          reserve={reserve.bound}
          ariaLabel={t("style_editor.lower_bound")}
          onChange={(v) => store.update((doc) => setManualBound(doc, ci, record, v), `${path}.from`)}
        />
      ) : null}
      {values && typeof record === "number" ? (
        <ButtonBase
          aria-haspopup="dialog"
          title={name || label || undefined}
          onClick={(event) => openValues(event.currentTarget, ci, record, values.classificationId)}
          sx={{
            ...labelColumn,
            minWidth: 0,
            height: 28,
            mx: -1,
            px: 1,
            borderRadius: 1,
            justifyContent: "flex-start",
            "&:hover": { bgcolor: "action.hover" },
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
          sx={{ ...labelColumn, minWidth: 0, typography: "body2", "& input": { p: 0 } }}
        />
      )}
      {count !== undefined ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ justifySelf: "end", fontVariantNumeric: "tabular-nums" }}>
          {formatNumberText(count, {}, i18n.language)}
        </Typography>
      ) : (
        <span />
      )}
      <IconButton
        size="small"
        aria-label={t(hidden ? "style_editor.show_class" : "style_editor.hide_class")}
        onClick={() => store.set(`${path}.visible`, hidden ? undefined : false)}>
        <Icon iconName={hidden ? ICON_NAME.EYE_SLASH : ICON_NAME.EYE} sx={{ fontSize: 12 }} />
      </IconButton>
      {record === "no_data" ? (
        <span />
      ) : (
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
      )}
    </Box>
  );
}

/** The legend's range words, unit and number format of classification `c`, and the data's minimum and maximum the
 * server computed with it, which its open classes read (as the legend does). */
const rangeOptions = (c: JsonObject, t: (key: string) => string, locale: string) => ({
  locale,
  words: {
    under: t("style_editor.range_under"),
    to: t("style_editor.range_to"),
    andMore: t("style_editor.range_and_more"),
  },
  unit: typeof c.unit === "string" ? c.unit : undefined,
  format: isObject(c.format) ? (c.format as RangeFormat) : undefined,
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
  return rangeText(
    { from: record.from as number | undefined, to: record.to as number | undefined },
    rangeOptions(c, t, locale)
  );
}

/** The range of a manual class after its typed bound: "to 14.81"; for the last class "to" the data's maximum, else
 * "and more". */
function rangeAfterBound(c: JsonObject, record: JsonObject, t: (key: string) => string, locale: string) {
  const options = rangeOptions(c, t, locale);
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
  /** The palette new classes take their colors from. */
  palette?: string | string[];
  /** The name of the property the classes set, over their values when the panel has no shorter row label for it. */
  valueLabel: string;
}

/** A record holding `value` at the dotted `key` ("marker.color" is `{ marker: { color } }`). */
const recordWith = (key: string, value: unknown): JsonObject =>
  key.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value) as JsonObject;

/** "Add class": a new category class with the first palette color no class has, its values open to pick. */
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
      const used = new Set(classes.map((k) => getIn(k, target)));
      const colors = paletteColors(palette, Math.max(classes.length + 1, 8));
      record = recordWith(target, colors.find((color) => !used.has(color)) ?? CATEGORY_GRAY);
    }
    store.update((doc) => addCategoryClass(doc, ci, record));
    openValues(anchor, ci, classes.length, typeof c.id === "string" ? c.id : undefined);
  };
  return (
    <Button
      variant="text"
      size="small"
      startIcon={<Icon iconName={ICON_NAME.PLUS} sx={{ fontSize: "12px !important" }} />}
      onClick={(event) => add(event.currentTarget)}
      sx={{
        mt: 1,
        ml: 2,
        height: 32,
        px: 2.5,
        borderRadius: 2,
        fontSize: 13,
        fontWeight: 700,
        textTransform: "none",
      }}>
      {t("style_editor.add_class")}
    </Button>
  );
}

export function ClassList({
  ci,
  c,
  target,
  choices,
  counts,
  showOther,
  palette,
  valueLabel,
}: ClassListProps) {
  const { t, i18n } = useTranslation("common");
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
  const head = { variant: "caption", color: "text.secondary", noWrap: true } as const;
  return (
    <Box sx={{ py: 1 }}>
      {/* The columns: the value the class sets, a rule, then the field's side: the lower bound (manual breaks), the
          label, the count; show or hide and style this class. The numbers stand at the end of their room, as in a
          table. */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: `auto 1px ${bounds ? "auto " : ""}minmax(0, 1fr) auto auto auto`,
          columnGap: 1,
          px: 3,
          "& [data-reserve]": { justifyContent: "flex-end" },
        }}>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "subgrid",
            gridColumn: "1 / -1",
            alignItems: "center",
            minHeight: 24,
          }}>
          {/* Over the numbers at their end, over swatches and choices at their start. */}
          <Typography
            {...head}
            sx={{ justifySelf: CAPABILITIES[target]?.kind === "number" ? "end" : "start" }}>
            {rowLabel ? t(rowLabel) : valueLabel}
          </Typography>
          <Rule />
          <Typography {...head} title={fieldLabel} sx={bounds ? { gridColumn: "span 2" } : undefined}>
            {fieldLabel}
          </Typography>
          <Typography {...head} sx={{ justifySelf: "end" }}>
            {t("features")}
          </Typography>
          <span />
          <span />
        </Box>
        {classes.map((record, i) => (
          <ClassRow
            key={typeof record.id === "string" ? record.id : i}
            ci={ci}
            record={i}
            target={target}
            label={bounds && i > 0 ? rangeAfterBound(c, record, t, i18n.language) : auto(record)}
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
            bounds={bounds}
            reserve={reserve}
            choices={choices}
          />
        )}
      </Box>
      {categories && <AddClassButton ci={ci} c={c} target={target} palette={palette ?? "colorbrewer:Set2"} />}
    </Box>
  );
}
