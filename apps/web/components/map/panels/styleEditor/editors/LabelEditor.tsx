"use client";

// The rows of the label (prototype 4.1 Label; spec 3.4): the text as one field or a template with a preview from
// the first feature, the number format when the text shows a number, the size and the color; then three rows that sum
// up their popovers: Halo (color and width), Text style (font, case, spacing, line height, wrap width) and Position
// (placement, offset, repeat distance, priority, overlap, space around).
import { Button, Typography } from "@mui/material";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { NumberFormatSpec } from "@/lib/style/compile/labels";
import { extrudes } from "@/lib/style/compile/polygons";
import type { Geometry } from "@/lib/style/compile/types";
import { recordPathOf, scopedView } from "@/lib/style/editor/classify";
import { LABEL_FONT_CHOICE, classificationFor } from "@/lib/style/editor/forms";
import { issueText } from "@/lib/style/editor/issues";
import {
  type LabelSummaryContext,
  fieldToken,
  fillTemplate,
  formatNumberText,
  isNumberType,
  labelHaloSummary,
  labelPositionSummary,
  labelTextStyleSummary,
  templateField,
  templateFields,
} from "@/lib/style/editor/labels";
import { perLayerPath } from "@/lib/style/editor/sources";
import { type Path, getIn } from "@/lib/style/editor/store";
import { type JsonObject, isObject } from "@/lib/style/json";

import { IssueNotice, useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useBasemapTone,
  useEditor,
  useMapZoom,
  useScope,
  useScoped,
  useStyleData,
  useStyleSelector,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { LabelLinesEditor } from "@/components/map/panels/styleEditor/editors/LabelLinesEditor";
import {
  NumberFormatEditor,
  PREVIEW_NUMBER,
} from "@/components/map/panels/styleEditor/editors/NumberFormatEditor";
import { OffsetRows } from "@/components/map/panels/styleEditor/editors/OffsetRows";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import { SetByRow } from "@/components/map/panels/styleEditor/editors/SetByRow";
import { choiceGlyph } from "@/components/map/panels/styleEditor/editors/choiceGlyph";
import { LETTER_CASES, type PartRow } from "@/components/map/panels/styleEditor/editors/partRows";
import { FieldPicker, FieldPickerButton } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { PLAIN } from "@/components/map/panels/styleEditor/plainText";
import {
  anchorTopOf,
  useIsOpen,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { ChoiceRow, NavRow, Row, TextRow } from "@/components/map/panels/styleEditor/rows";

const SIZE: PartRow = { type: "number", key: "size", label: "style_editor.size" };
const COLOR: PartRow = { type: "color", key: "color", label: "style_editor.color" };
/** Light, Regular, Medium or Bold, upright or italic: one choice over the weight and the style, also by zoom and by
 * classes. */
const FONT: PartRow = {
  type: "choice",
  key: "font.weight",
  label: "style_editor.font",
  values: LABEL_FONT_CHOICE.values,
  compound: LABEL_FONT_CHOICE,
};
const CASE: PartRow = {
  type: "choice",
  key: "transform",
  label: "style_editor.letter_case",
  values: LETTER_CASES,
};
// In the Halo popover, whose title names the halo.
const HALO_COLOR: PartRow = { type: "color", key: "halo.color", label: "style_editor.color" };
const HALO_WIDTH: PartRow = { type: "number", key: "halo.width", label: "style_editor.width" };
const MAX_WIDTH: PartRow = { type: "number", key: "max_width", label: "style_editor.max_width" };
const LETTER_SPACING: PartRow = {
  type: "number",
  key: "letter_spacing",
  label: "style_editor.letter_spacing",
};
const LINE_HEIGHT: PartRow = { type: "number", key: "line_height", label: "style_editor.line_height" };
const OVERLAP: PartRow = {
  type: "switch",
  key: "allow_overlap",
  label: "style_editor.overlap",
  note: "style_editor.note_label_overlap",
};
const SPACING: PartRow = {
  type: "number",
  key: "spacing",
  label: "style_editor.label_spacing",
  note: "style_editor.note_label_spacing",
};
const PADDING: PartRow = {
  type: "number",
  key: "padding",
  label: "style_editor.label_padding",
  note: "style_editor.note_label_padding",
};
/** The sides of the marker in the order of their grid glyphs, row by row, with `middle` in the middle. */
const AROUND = (middle: string) => [
  "above_left",
  "above",
  "above_right",
  "left",
  middle,
  "right",
  "below_left",
  "below",
  "below_right",
];
/** Around a point's marker; along a line or around the marker at its center; around an area's marker (spec 3.4). */
const PLACEMENT: Record<Geometry, PartRow> = {
  point: {
    type: "choice",
    key: "placement",
    label: "style_editor.placement",
    values: ["auto", ...AROUND("center")],
    fallback: "auto",
  },
  line: {
    type: "choice",
    key: "placement",
    label: "style_editor.placement",
    values: ["line", "auto", ...AROUND("center")],
    fallback: "line",
  },
  polygon: {
    type: "choice",
    key: "placement",
    label: "style_editor.placement",
    values: ["auto", ...AROUND("inside")],
    fallback: "auto",
  },
};

function TextRows({ base }: { base: Path }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const popover = usePopover();
  const next = useNextLevel();
  // In class scope the text is the class's own (label.text varies per feature); the number format is the layer's.
  const scopedText = useScoped(`${base}.text`);
  const textPath = scopedText.writePath;
  const text = scopedText.value;
  const issues = useIssueAt(textPath);
  // Number formats are one for the layer, wherever they are set (spec 6.1).
  const formatPath = useStyleSelector((doc) => perLayerPath(doc, `${base}.format`));
  const formatsPath = useStyleSelector((doc) => perLayerPath(doc, `${base}.formats`));
  const format = useStyleValue<NumberFormatSpec | undefined>(formatPath);
  const formats = useStyleValue<Record<string, NumberFormatSpec> | undefined>(formatsPath);
  const template = typeof text === "string" ? text : "";
  const field = templateField(template);
  // "Custom text" is a panel choice: a template of one field still shows as a template once picked.
  const [custom, setCustom] = useState(() => template !== "" && field === null);
  const fieldLabel = (name: string) => data.fields.find((f) => f.name === name)?.label ?? name;
  const numberFields = [
    ...new Set(templateFields(template).filter((name) => isNumberType(data.fieldTypes[name]))),
  ];
  const usesNumber = numberFields.length > 0;
  const templateLines = template ? template.split("\n").length : 0;
  const label = t("style_editor.text");

  const [insertAnchor, setInsertAnchor] = useState<HTMLElement | null>(null);

  // The template box writes a text as a whole (the server takes back a template it cannot read). A text it wrote that
  // came back refused (an error at its path, the text as it was before) stays in the box to be corrected; any other
  // change of the text drops it.
  const [written, setWritten] = useState<{ text: string; over: string } | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const refused =
    written !== null &&
    written.text !== template &&
    written.over === template &&
    issues.some((issue) => issue.level === "error");
  const boxText = refused ? written.text : template;
  useEffect(() => {
    if (written && template !== written.text && template !== written.over) setWritten(null);
  }, [template, written]);
  const writeTemplate = (value: string) => {
    setWritten({ text: value, over: template });
    store.set(textPath, value || undefined);
  };

  // The preview in the case the map draws (the class's own in class scope), of the text in the box.
  const transform = useScoped(`${base}.transform`).value;
  const filled = fillTemplate(
    typing ?? boxText,
    data.sample,
    data.fieldTypes,
    format ?? {},
    i18n.language,
    formats
  );
  const preview =
    transform === "uppercase"
      ? filled.toLocaleUpperCase(i18n.language)
      : transform === "lowercase"
        ? filled.toLocaleLowerCase(i18n.language)
        : filled;
  return (
    <>
      <Row label={label}>
        <FieldPickerButton
          ariaLabel={label}
          text={
            custom
              ? t("style_editor.custom_text")
              : field !== null
                ? fieldLabel(field)
                : template || t("style_editor.no_text")
          }
          title={label}
          fields={data.fields}
          value={custom ? undefined : (field ?? undefined)}
          before={[
            {
              label: t("style_editor.custom_text"),
              sub: t("style_editor.custom_text_sub"),
              icon: ICON_NAME.EDIT,
              selected: custom,
              onClick: () => setCustom(true),
            },
          ]}
          onChange={(name) => {
            setCustom(false);
            store.set(textPath, fieldToken(name));
          }}
        />
      </Row>
      {custom && (
        <>
          <TextRow
            label={t("style_editor.template")}
            multiline
            value={boxText}
            placeholder={t("style_editor.template_placeholder")}
            note={t("style_editor.template_note")}
            commitOnLeave
            onDraft={setTyping}
            onChange={writeTemplate}
          />
          <Row>
            <Button
              variant="text"
              size="small"
              color="inherit"
              aria-haspopup="listbox"
              aria-expanded={insertAnchor !== null}
              onClick={(event) => setInsertAnchor(insertAnchor ? null : event.currentTarget)}>
              {t("style_editor.insert_field")}
            </Button>
            <FieldPicker
              anchorEl={insertAnchor}
              onClose={() => setInsertAnchor(null)}
              title={t("style_editor.insert_field")}
              placement="bottom-start"
              fields={data.fields}
              onChange={(name) => writeTemplate(`${boxText}${fieldToken(name)}`)}
            />
          </Row>
        </>
      )}
      {issues.map((issue, i) => (
        <IssueNotice key={`${issue.code}-${i}`} issue={issue} />
      ))}
      {/* Texts classes set: the classification that sets them, which the Label row names. */}
      {!scopedText.scoped && (
        <SetByRow setterOf={(doc) => classificationFor(doc, "label.text", data.geometry)} />
      )}
      <Row label={t("style_editor.preview")}>
        <Typography variant="body2" sx={{ whiteSpace: "pre-line", minWidth: 0 }}>
          {preview || t("style_editor.no_text")}
        </Typography>
      </Row>
      {numberFields.length > 1 &&
        !scopedText.scoped &&
        numberFields.map((name) => (
          <NavRow
            key={name}
            label={t("style_editor.numbers_in", { field: fieldLabel(name), ...PLAIN })}
            value={
              formats?.[name]
                ? t("style_editor.example", {
                    value: formatNumberText(
                      PREVIEW_NUMBER,
                      { ...(format ?? {}), ...formats[name] },
                      i18n.language
                    ),
                    ...PLAIN,
                  })
                : t("style_editor.as_all_numbers")
            }
            onOpen={(anchor) =>
              popover.open(next, {
                key: `label:format:${name}`,
                title: t("style_editor.numbers_in", { field: fieldLabel(name), ...PLAIN }),
                anchorTop: anchorTopOf(anchor),
                render: () => <NumberFormatEditor path={`${formatsPath}.${name}`} />,
              })
            }
          />
        ))}
      {templateLines > 1 && !scopedText.scoped && (
        <NavRow
          label={t("style_editor.line_styles")}
          value={t("style_editor.lines_n", { n: templateLines })}
          onOpen={(anchor) =>
            popover.open(next, {
              key: "label:lines",
              title: t("style_editor.line_styles"),
              anchorTop: anchorTopOf(anchor),
              render: () => <LabelLinesEditor base={base} count={templateLines} />,
            })
          }
        />
      )}
      {usesNumber && !scopedText.scoped && (
        <NavRow
          label={t("style_editor.numbers")}
          value={
            format
              ? t("style_editor.example", {
                  value: formatNumberText(PREVIEW_NUMBER, format, i18n.language),
                  ...PLAIN,
                })
              : t("style_editor.as_in_dataset")
          }
          onOpen={(anchor) =>
            popover.open(next, {
              key: "label:format",
              title: t("style_editor.number_format"),
              anchorTop: anchorTopOf(anchor),
              render: () => <NumberFormatEditor path={formatPath} />,
            })
          }
        />
      )}
    </>
  );
}

function PriorityRow({ base }: { base: Path }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields } = useStyleData();
  // One for the layer, wherever it is set (spec 6.1).
  const path = useStyleSelector((doc) => perLayerPath(doc, `${base}.priority`));
  const priority = useStyleValue<unknown>(path);
  const current = isObject(priority) ? `${String(priority.top)}:${String(priority.field)}` : "";
  const label = t("style_editor.priority");
  return (
    <ChoiceRow<string>
      label={label}
      value={current}
      options={[
        { value: "", label: t("style_editor.no_priority") },
        ...fields
          .filter((f) => isNumberType(f.type))
          .flatMap((f) => [
            {
              value: `largest:${f.name}`,
              label: t("style_editor.priority_largest", { field: f.label, ...PLAIN }),
            },
            {
              value: `smallest:${f.name}`,
              label: t("style_editor.priority_smallest", { field: f.label, ...PLAIN }),
            },
          ]),
      ]}
      onChange={(value) => {
        const at = value.indexOf(":");
        store.set(path, at < 0 ? undefined : { field: value.slice(at + 1), top: value.slice(0, at) });
      }}
    />
  );
}

function HaloRows({ base }: { base: Path }) {
  return (
    <>
      <PropertyRow row={HALO_COLOR} base={base} />
      <PropertyRow row={HALO_WIDTH} base={base} />
    </>
  );
}

function TextStyleRows({ base }: { base: Path }) {
  return (
    <>
      <PropertyRow row={FONT} base={base} />
      <PropertyRow row={CASE} base={base} />
      <PropertyRow row={LETTER_SPACING} base={base} />
      <PropertyRow row={LINE_HEIGHT} base={base} />
      <PropertyRow row={MAX_WIDTH} base={base} />
    </>
  );
}

function PositionRows({ base }: { base: Path }) {
  const { geometry } = useStyleData();
  const overlap = useStyleSelector((doc) => getIn(doc, perLayerPath(doc, `${base}.allow_overlap`)) === true);
  // One placement for the layer, wherever it is set (spec 6.1).
  const placed = useStyleSelector((doc) => {
    const value = getIn(doc, perLayerPath(doc, `${base}.placement`));
    return typeof value === "string" ? value : undefined;
  });
  const scoped = useScope() !== null;
  // Polygon labels of a layer with a height sit on the roofs (3D spec 7.5): said under the placement.
  const extruded = useStyleSelector((doc) => extrudes(doc as unknown as JsonObject));
  const placement = geometry
    ? geometry === "polygon" && extruded
      ? { ...PLACEMENT.polygon, note: "style_editor.note_label_roof" }
      : PLACEMENT[geometry]
    : undefined;
  // Only a label along a line repeats.
  const repeats = geometry === "line" && (placed ?? "line") === "line";
  return (
    <>
      {placement && <PropertyRow row={placement} base={base} />}
      <OffsetRows base={base} rangeKey="label.offset" />
      {repeats && <PropertyRow row={SPACING} base={base} />}
      {!overlap && !scoped && <PriorityRow base={base} />}
      <PropertyRow row={OVERLAP} base={base} />
      <PropertyRow row={PADDING} base={base} />
    </>
  );
}

/** The keys under the Halo, Text style and Position rows, relative to the label: their issues and a class's or rule's
 * own values show on the row. */
const HALO_KEYS = ["halo"];
const TEXT_STYLE_KEYS = ["font", "transform", "letter_spacing", "line_height", "max_width"];
const POSITION_KEYS = ["placement", "offset", "spacing", "priority", "allow_overlap", "padding"];

/** A row that sums up the rows of its popover and opens it, as the Numbers row does. In class or rule scope it shows
 * what the class or rule draws, with a dot when it sets one of the keys itself; a dot warns of an issue inside. */
function SummaryRow({
  base,
  id,
  label,
  keys,
  value,
  swatch,
  glyph,
  tooltip,
  render,
}: {
  base: Path;
  id: string;
  label: string;
  keys: string[];
  value: string;
  swatch?: string;
  glyph?: ReactNode;
  /** The whole summary on hover, where it is long enough to be cut. */
  tooltip?: boolean;
  render: () => ReactNode;
}) {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const next = useNextLevel();
  const scope = useScope();
  const key = `label:${id}`;
  const open = useIsOpen(key);
  const own = useStyleSelector(
    (doc) => scope !== null && keys.some((k) => scopedView(doc, scope).overridden(`${base}.${k}`))
  );
  const record = scope ? `${recordPathOf(scope)}.${base.slice("symbol.".length)}` : base;
  const issues = useIssueAt(keys.map((k) => `${record}.${k}`));
  return (
    <NavRow
      label={label}
      value={value}
      swatch={swatch ? { background: swatch } : undefined}
      glyph={glyph}
      tooltip={tooltip ? value : undefined}
      overrideDot={own}
      warn={issues[0] && issueText(t, issues[0])}
      active={open}
      onOpen={(anchor) => popover.open(next, { key, title: label, anchorTop: anchorTopOf(anchor), render })}
    />
  );
}

/** What the summaries read: the fields, the map zoom, the geometry, the panel's language and the basemap's tone. */
function useSummaryContext(): LabelSummaryContext {
  const { i18n } = useTranslation("common");
  const { fields, geometry } = useStyleData();
  const mapZoom = useMapZoom();
  const tone = useBasemapTone();
  return { fields, mapZoom, geometry, language: i18n.language, tone };
}

function HaloRow({ base }: { base: Path }) {
  const { t } = useTranslation("common");
  const scope = useScope();
  const ctx = useSummaryContext();
  const text = useStyleSelector((doc) => labelHaloSummary(doc, base, scope, t, ctx).text);
  const swatch = useStyleSelector((doc) => labelHaloSummary(doc, base, scope, t, ctx).swatch);
  return (
    <SummaryRow
      base={base}
      id="halo"
      label={t("style_editor.halo")}
      keys={HALO_KEYS}
      value={text}
      swatch={swatch}
      render={() => <HaloRows base={base} />}
    />
  );
}

function TextStyleRow({ base }: { base: Path }) {
  const { t } = useTranslation("common");
  const scope = useScope();
  const ctx = useSummaryContext();
  const text = useStyleSelector((doc) => labelTextStyleSummary(doc, base, scope, t, ctx));
  return (
    <SummaryRow
      base={base}
      id="text-style"
      label={t("style_editor.text_style")}
      keys={TEXT_STYLE_KEYS}
      value={text}
      tooltip
      render={() => <TextStyleRows base={base} />}
    />
  );
}

function PositionRow({ base }: { base: Path }) {
  const { t } = useTranslation("common");
  const ctx = useSummaryContext();
  const placement = useStyleSelector((doc) => labelPositionSummary(doc, base, t, ctx).placement);
  const text = useStyleSelector((doc) => labelPositionSummary(doc, base, t, ctx).text);
  return (
    <SummaryRow
      base={base}
      id="position"
      label={t("style_editor.label_position")}
      keys={POSITION_KEYS}
      value={text}
      // The grid with the side the label sits on, as in the placement's choices; none along a line.
      glyph={choiceGlyph("label.placement", placement, ctx.geometry)}
      render={() => <PositionRows base={base} />}
    />
  );
}

export function LabelEditor({ base }: { base: Path }) {
  return (
    <>
      <TextRows base={base} />
      <PropertyRow row={SIZE} base={base} />
      <PropertyRow row={COLOR} base={base} />
      <HaloRow base={base} />
      <TextStyleRow base={base} />
      <PositionRow base={base} />
    </>
  );
}
