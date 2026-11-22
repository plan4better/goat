"use client";

// One classification (spec 5, prototype 4.5): its field, the property it sets, the method and number of classes, the
// palette or range, the field's histogram with the breaks, and the class list. The server computes the classes: an
// intent edit saves at once and the classes show as pending until the reply. Conflicts between classifications
// come from the server's issues; the panel draws no conclusions of its own.
import { Alert, Box, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { useUniqueValues } from "@/lib/api/processes";
import { useProjectLayerHistogramStats } from "@/lib/api/projects";
import {
  CLASS_COUNTS,
  MAX_CLASS_COUNT,
  classColorsByHand,
  classValuesByHand,
  classesPending,
  classifyTargets,
  clearClassValues,
  pickClassRange,
  recolorClasses,
  removeClassification,
  retarget,
  serverFillsClasses,
  setClassificationField,
  setMethod,
} from "@/lib/style/editor/classify";
import { SLIDERS, withStored } from "@/lib/style/editor/defaults";
import { targetsOf } from "@/lib/style/editor/forms";
import { formatNumberText, isNumberType } from "@/lib/style/editor/labels";
import { getIn, setIn } from "@/lib/style/editor/store";
import { CAPABILITIES, defaultRange } from "@/lib/style/generated/capabilities";
import { PALETTES } from "@/lib/style/generated/catalog";
import { type JsonObject, isObject } from "@/lib/style/json";

import FieldKindIcon, { fieldIndicatorKind } from "@/components/common/FieldKindIcon";
import { IssueNotice, useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useEditor,
  useFieldProfile,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { profileRange } from "@/components/map/panels/styleEditor/editors/AttributeEditor";
import { ClassList } from "@/components/map/panels/styleEditor/editors/ClassList";
import { VALUES_LIMIT } from "@/components/map/panels/styleEditor/editors/ClassValues";
import { Histogram } from "@/components/map/panels/styleEditor/editors/Histogram";
import { choiceValues } from "@/components/map/panels/styleEditor/editors/partRows";
import { FieldPickerButton } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { PalettePicker, paletteColors } from "@/components/map/panels/styleEditor/pickers/PalettePicker";
import {
  anchorTopOf,
  useCloseWhenGone,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, Row } from "@/components/map/panels/styleEditor/rows";

const NUMERIC_METHODS = [
  "quantile",
  "equal_interval",
  "natural_breaks",
  "std_dev",
  "heads_and_tails",
  "geometric_interval",
  "manual",
];
/** Top counts of a categories classification, after All values. */
const CATEGORY_COUNTS = [3, 5, 8, 12];
const HISTOGRAM_BINS = 28;
/** The class list keeps at least this much height (px) when the window is short; the rest of the editor scrolls. */
const CLASS_LIST_MIN = 160;
/** The palettes the spec uses when a classification names none (18.4). */
const DEFAULT_PALETTE = { categories: "colorbrewer:Set2", numeric: "goat:green" };

export const propLabelKey = (key: string) => `style_editor.prop_${key.replace(/\./g, "_")}`;

/** A palette as its row names it: the catalog's name, ", reversed" when reversed; a list of colors is one's own. */
export function paletteLabel(palette: string | string[], reversed: boolean, t: TFunction): string {
  if (Array.isArray(palette)) return t("style_editor.palette_custom");
  return `${PALETTES[palette]?.name ?? palette}${reversed ? `, ${t("style_editor.reversed")}` : ""}`;
}

/** The range row's value while the classes hold values typed by hand. */
const OWN_VALUES = "own";

/** Range presets for a number target: the default range, a narrower and a wider one. */
function rangePresets(key: string): Array<[number, number]> {
  const [a, b] = defaultRange(key);
  const max = SLIDERS[key]?.max ?? b * 2;
  const round = (n: number) => Math.round(n * 100) / 100;
  const presets: Array<[number, number]> = [
    [a, round(a + (b - a) / 2)],
    [a, b],
    [a, round(Math.min(max, b * 1.5))],
  ];
  return presets.filter((p, i) => presets.findIndex((q) => q[0] === p[0] && q[1] === p[1]) === i);
}

function ClassPalettePicker({
  ci,
  steps,
  categories,
  target,
}: {
  ci: number;
  steps: number;
  categories: boolean;
  target: string;
}) {
  const store = useEditor();
  const path = `classify.${ci}`;
  const palette = useStyleValue<string | string[] | undefined>(`${path}.palette`);
  const reverse = useStyleValue<boolean | undefined>(`${path}.reverse`);
  // A new palette takes every class: the server colors again the classes it fills, also a color picked by hand;
  // the panel colors manual classes and categories picked by hand itself.
  const write = (next: string | string[], reversed: boolean) =>
    store.update((doc) => {
      let out = setIn(doc, `${path}.palette`, next);
      out = setIn(out, `${path}.reverse`, reversed || undefined);
      const c = store.get(path);
      if (isObject(c) && serverFillsClasses(c)) return clearClassValues(out, ci, target);
      const colors = paletteColors(next, steps);
      return recolorClasses(out, ci, target, reversed ? [...colors].reverse() : colors);
    });
  const current = palette ?? DEFAULT_PALETTE[categories ? "categories" : "numeric"];
  return (
    <PalettePicker
      value={current}
      reverse={reverse === true}
      steps={steps}
      kinds={categories ? ["qualitative"] : ["sequential", "diverging"]}
      onChange={(next) => write(next, reverse === true)}
      onReverse={(next) => write(current, next)}
    />
  );
}

/** Where the classification `id` is now (classifications move and get removed while an editor is open); `ci` for one
 * without an id. -1 when it is gone. */
export function classificationIndex(all: unknown, ci: number, id?: string): number {
  if (id === undefined) return ci;
  return Array.isArray(all) ? all.findIndex((c) => isObject(c) && c.id === id) : -1;
}

export function ClassificationEditor({ ci: opened, id }: { ci: number; id?: string }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const popover = usePopover();
  const all = useStyleValue<unknown>("classify");
  const ci = classificationIndex(all, opened, id);
  const path = `classify.${ci}`;
  const value = useStyleValue<unknown>(path);
  const issues = useIssueAt(path).filter((issue) => !/^\/classify\/[^/]+\/classes\//.test(issue.path));
  const subscribe = useCallback((listener: () => void) => store.saver.subscribe(listener), [store]);
  // Each reply changes the stored document: the classes may stop pending.
  const readStored = () => store.saver.stored;
  useSyncExternalStore(subscribe, readStored, readStored);
  const c = (isObject(value) ? value : {}) as JsonObject;
  const field = typeof c.field === "string" ? c.field : "";
  const fieldType = data.fieldTypes[field];
  const numericField = isNumberType(fieldType);
  const categories = c.method === "categories";
  const classes = (Array.isArray(c.classes) ? c.classes : []).filter(isObject);
  const breaks = classes
    .slice(1)
    .map((record) => record.from)
    .filter((b): b is number => typeof b === "number");
  const layerId = data.layerId || undefined;
  const { histogramStats } = useProjectLayerHistogramStats(
    numericField && !categories ? layerId : undefined,
    { column_name: field, num_bins: HISTOGRAM_BINS, method: "equal_interval" }
  );
  const { histogramStats: classStats } = useProjectLayerHistogramStats(
    numericField && !categories && breaks.length ? layerId : undefined,
    { column_name: field, num_bins: breaks.length + 1, method: "custom_breaks", custom_breaks: breaks }
  );
  const { data: uniqueValues } = useUniqueValues(categories ? layerId : undefined, field, {
    limit: VALUES_LIMIT,
  });
  // Geometric intervals need every value above 0 (spec 5.8): the field's minimum, once its profile is known.
  const profile = useFieldProfile(numericField ? field : undefined);
  // A classification removed while its editor is open (its property set back to one value): the editor closes.
  const gone = !isObject(value);
  useCloseWhenGone(gone);
  if (gone)
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 3, py: 2 }}>
        {t("style_editor.not_classified")}
      </Typography>
    );

  const geometry = data.geometry;
  const target = targetsOf(c, geometry)[0];
  // A target the menu does not offer (a style written elsewhere) stays in it while set.
  const targets = geometry ? classifyTargets(geometry) : [];
  if (geometry && !targets.includes(target)) targets.push(target);
  const kind = CAPABILITIES[target]?.kind;
  const locale = i18n.language;
  const number = (n: number) => formatNumberText(n, {}, locale);
  const pending = classesPending(store, ci);
  const others = (Array.isArray(all) ? all : []).filter(isObject);
  const fieldLabel = data.fields.find((f) => f.name === field)?.label ?? field;

  const methods = numericField ? ["categories", ...NUMERIC_METHODS] : ["categories"];
  const byHand = categories && typeof c.count !== "number";
  const counts = [
    ...(categories ? ["all"] : []),
    ...withStored(
      categories ? CATEGORY_COUNTS : CLASS_COUNTS,
      c.count === MAX_CLASS_COUNT && categories ? undefined : c.count
    ).map(String),
  ];
  const count = byHand
    ? "by_hand"
    : c.count === MAX_CLASS_COUNT && categories
      ? "all"
      : typeof c.count === "number"
        ? String(c.count)
        : "5";
  const palette = (c.palette ?? DEFAULT_PALETTE[categories ? "categories" : "numeric"]) as string | string[];
  const classColors = classes
    .map((record) => getIn(record, target))
    .filter((v): v is string => typeof v === "string");
  const stripColors = classColors.length ? classColors : paletteColors(palette, classes.length || undefined);
  const strip = stripColors.length
    ? `linear-gradient(90deg, ${stripColors
        .map(
          (color, i) => `${color} ${(i / stripColors.length) * 100}% ${((i + 1) / stripColors.length) * 100}%`
        )
        .join(", ")})`
    : undefined;
  const range = Array.isArray(c.range) ? (c.range as [number, number]) : defaultRange(target);
  const unit = SLIDERS[target]?.unit ?? "";
  const pct = SLIDERS[target]?.pct;
  const rangeLabel = ([a, b]: [number, number]) =>
    pct
      ? `${Math.round(a * 100)} ${t("style_editor.to")} ${Math.round(b * 100)}%`
      : `${a} ${t("style_editor.to")} ${b}${unit ? ` ${unit}` : ""}`;
  const presets = rangePresets(target);
  if (!presets.some(([a, b]) => a === range[0] && b === range[1])) presets.push(range);
  // Values typed into the classes follow no range: the row says so, and a picked range takes every class again.
  const ownValues = kind === "number" && classValuesByHand(c, target, range);
  // Colors picked by hand follow no palette: the palette row says so, as the range row does.
  const ownColors =
    kind === "color" &&
    classColorsByHand(c, target, [
      ...paletteColors(palette),
      ...paletteColors(palette, classes.length || undefined),
    ]);

  const classColorAt = (v: number) => {
    const i = breaks.filter((b) => v >= b).length;
    const color = classes[i] ? getIn(classes[i], target) : undefined;
    return typeof color === "string" ? color : "#9aa3ad";
  };

  const valueCounts = new Map((uniqueValues?.values ?? []).map((item) => [String(item.value), item.count]));
  const classCounts = categories
    ? classes.map((record) =>
        Array.isArray(record.values) && record.values.length
          ? record.values.reduce<number>((sum, v) => sum + (valueCounts.get(String(v)) ?? 0), 0)
          : undefined
      )
    : classStats?.bins.map((bin) => bin.count);
  const noDataCount = (categories ? undefined : histogramStats?.missing_count) ?? undefined;
  // Values in no class draw as Other; their count is known when every value of the field is in the list.
  const classed = new Set(
    classes.flatMap((record) => (Array.isArray(record.values) ? record.values.map(String) : []))
  );
  const valueTotal = uniqueValues?.total ?? 0;
  const otherShown = categories && valueTotal > classed.size;
  const otherCount =
    otherShown && uniqueValues && uniqueValues.values.length >= valueTotal
      ? uniqueValues.values.reduce((sum, v) => (classed.has(String(v.value)) ? sum : sum + v.count), 0)
      : undefined;
  // Whether the data holds such features at all: the panel's own numbers where it has them, else what the server
  // recorded with the classes (`computed.no_data`, `computed.other`, which the legend follows too).
  const facts = isObject(c.computed) ? c.computed : {};
  const noDataAbsent = noDataCount !== undefined ? noDataCount === 0 : facts.no_data === false;
  const otherAbsent = categories && (uniqueValues ? !otherShown : facts.other === false);
  // A field whose values are nearly all different (an id) makes classes of one feature each.
  const idField =
    categories &&
    data.featureCount !== undefined &&
    data.featureCount > 20 &&
    valueTotal >= data.featureCount * 0.9;

  const computed = isObject(c.computed) ? c.computed : undefined;
  const at = typeof computed?.at === "string" ? new Date(computed.at) : undefined;
  const meta = pending
    ? t("style_editor.computing_classes")
    : c.method === "manual"
      ? t("style_editor.manual_meta")
      : categories && c.count === undefined
        ? t("style_editor.categories_by_hand")
        : at && !Number.isNaN(at.getTime())
          ? t("style_editor.computed_meta", {
              features: data.featureCount !== undefined ? number(data.featureCount) : "…",
              time: `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`,
            })
          : undefined;

  return (
    <>
      {/* The settings stay in view; a long class list scrolls on its own below them (the popover's `fill`). */}
      <Box sx={{ flex: "none" }}>
        <Row label={t("style_editor.field")}>
          <FieldPickerButton
            ariaLabel={t("style_editor.field")}
            start={fieldType && <FieldKindIcon kind={fieldIndicatorKind({ type: fieldType })} />}
            text={fieldLabel || t("style_editor.pick_field")}
            fields={data.fields.filter((f) => f.type !== "date" && f.type !== "datetime")}
            value={field}
            profile={(_, loaded) => profileRange(loaded, locale, t("style_editor.to"))}
            onChange={(name) => {
              const picked = data.fields.find((f) => f.name === name);
              if (picked) store.update((doc) => setClassificationField(doc, ci, picked));
            }}
          />
        </Row>
        {idField && (
          <Box sx={{ px: 3, py: 1 }}>
            <Alert severity="warning" sx={{ py: 0, px: 2, "& .MuiAlert-message": { fontSize: "0.75rem" } }}>
              {t("style_editor.id_field_hint", { field: fieldLabel })}
            </Alert>
          </Box>
        )}
        {geometry && (
          <ChoiceRow<string>
            label={t("style_editor.sets")}
            value={target}
            options={targets.map((key) => {
              const owner = others.find((other, k) => k !== ci && targetsOf(other, geometry).includes(key));
              return {
                value: key,
                label: t(propLabelKey(key)),
                sub: owner ? t("style_editor.also_set_by", { field: String(owner.field) }) : undefined,
              };
            })}
            onChange={(key) => store.update((doc) => retarget(doc, ci, key, geometry))}
          />
        )}
        {issues.length > 0 && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1, px: 3, py: 1 }}>
            {issues.map((issue, i) => (
              <IssueNotice key={`${issue.code}-${i}`} issue={issue} />
            ))}
          </Box>
        )}
        <ChoiceRow<string>
          label={t("style_editor.method")}
          value={String(c.method)}
          options={methods.map((m) => {
            const negative = m === "geometric_interval" && profile?.min !== undefined && profile.min <= 0;
            return {
              value: m,
              label: t(`style_editor.method_${m}`),
              // The field's own lowest value says why.
              sub: negative
                ? t("style_editor.geometric_field_below", { min: number(profile?.min ?? 0) })
                : t(`style_editor.method_${m}_sub`),
              disabled: negative,
            };
          })}
          onChange={(m) => store.update((doc) => setMethod(doc, ci, m))}
        />
        {c.method !== "manual" && (
          <ChoiceRow<string>
            label={t("style_editor.classes")}
            value={count}
            options={[...(byHand ? ["by_hand"] : []), ...counts].map((n) => ({
              value: n,
              label:
                n === "by_hand"
                  ? t("style_editor.count_by_hand")
                  : n === "all"
                    ? t("style_editor.count_all")
                    : categories
                      ? t("style_editor.count_top", { count: Number(n) })
                      : t("style_editor.count_classes", { count: Number(n) }),
            }))}
            onChange={(n) => {
              if (n !== "by_hand") store.set(`${path}.count`, n === "all" ? MAX_CLASS_COUNT : Number(n));
            }}
          />
        )}
        {kind === "color" && (
          <NavRow
            label={t("style_editor.palette")}
            value={
              ownColors ? t("style_editor.palette_custom") : paletteLabel(palette, c.reverse === true, t)
            }
            swatch={strip ? { background: strip, wide: true } : undefined}
            onOpen={(anchor) =>
              popover.open("picker", {
                key: `class-palette:${ci}`,
                title: t("style_editor.palette"),
                anchorTop: anchorTopOf(anchor),
                anchorEl: anchor,
                render: () => (
                  <ClassPalettePicker
                    ci={ci}
                    steps={classes.length || 5}
                    categories={categories}
                    target={target}
                  />
                ),
              })
            }
          />
        )}
        {kind === "number" && (
          <ChoiceRow<string>
            label={t("style_editor.range")}
            value={ownValues ? OWN_VALUES : range.join(":")}
            options={[
              ...(ownValues ? [{ value: OWN_VALUES, label: t("style_editor.range_own") }] : []),
              ...presets.map((p) => ({ value: p.join(":"), label: rangeLabel(p) })),
            ]}
            onChange={(v) => {
              if (v === OWN_VALUES) return;
              const picked = v.split(":").map(Number) as [number, number];
              store.update((doc) => pickClassRange(doc, ci, target, picked));
            }}
          />
        )}
        {histogramStats && histogramStats.bins.length > 0 && (
          <Box sx={{ px: 3, py: 1 }}>
            <Histogram bins={histogramStats.bins} breaks={breaks} colorAt={classColorAt} format={number} />
          </Box>
        )}
      </Box>
      <Box
        data-popover-scroll
        sx={{
          flex: "0 1 auto",
          overflowY: "auto",
          minHeight: Math.min(CLASS_LIST_MIN, (classes.length + 2) * 32),
        }}>
        <ClassList
          ci={ci}
          c={c}
          target={target}
          choices={kind === "choice" ? choiceValues(target) : undefined}
          counts={{
            classes: classCounts,
            other: otherAbsent ? 0 : otherCount,
            noData: noDataAbsent ? 0 : noDataCount,
          }}
          showOther={otherShown}
          absent={{ other: otherAbsent, noData: noDataAbsent }}
          palette={palette}
          valueLabel={t(propLabelKey(target))}
        />
      </Box>
      {meta && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", flex: "none", px: 3, pt: 1 }}>
          {meta}
        </Typography>
      )}
    </>
  );
}

/** The popover key of the editor of `classify[ci]`: its id, else its index. */
export const classificationKey = (c: JsonObject, ci: number) =>
  `classes:${typeof c.id === "string" ? c.id : ci}`;

/** Opens the editor of `classify[ci]` one level deeper than the caller, with "Remove classification". */
export function useClassificationOpener(): (ci: number, anchorTop: number) => void {
  const { t } = useTranslation("common");
  const store = useEditor();
  const popover = usePopover();
  const next = useNextLevel();
  const { geometry } = useStyleData();
  return (ci, anchorTop) => {
    const c = getIn(store.document, `classify.${ci}`);
    if (!isObject(c)) return;
    const id = typeof c.id === "string" ? c.id : undefined;
    popover.open(next, {
      key: classificationKey(c, ci),
      title: t("style_editor.by_classes_title", { label: t(propLabelKey(targetsOf(c, geometry)[0])) }),
      anchorTop,
      fill: true,
      render: () => <ClassificationEditor ci={ci} id={id} />,
      onDelete: {
        label: t("style_editor.remove_classification"),
        onClick: () => {
          const now = classificationIndex(store.get("classify"), ci, id);
          if (now >= 0) store.update((doc) => removeClassification(doc, now));
          store.setScope(null);
          popover.close(next);
        },
      },
    });
  };
}
