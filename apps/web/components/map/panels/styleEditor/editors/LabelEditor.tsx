"use client";

// The rows of the label (prototype 4.1 Label; spec 3.4): the text as one field or a template with a preview from
// the first feature, the number format when the text shows a number, the text's look, placement, offset, priority
// and overlap.
import { Button, ListItemText, MenuItem, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { NumberFormatSpec } from "@/lib/style/compile/labels";
import type { Geometry } from "@/lib/style/compile/types";
import { SLIDERS } from "@/lib/style/editor/defaults";
import {
  fieldToken,
  fillTemplate,
  formatNumberText,
  isNumberType,
  templateField,
  templateFields,
} from "@/lib/style/editor/labels";
import type { Path } from "@/lib/style/editor/store";
import { isObject } from "@/lib/style/json";

import { IssueNotice, useIssueAt } from "@/components/map/panels/styleEditor/IssueNotice";
import {
  useEditor,
  useScope,
  useScoped,
  useStyleData,
  useStyleValue,
} from "@/components/map/panels/styleEditor/context";
import { LabelLinesEditor } from "@/components/map/panels/styleEditor/editors/LabelLinesEditor";
import {
  NumberFormatEditor,
  PREVIEW_NUMBER,
} from "@/components/map/panels/styleEditor/editors/NumberFormatEditor";
import { PropertyRow } from "@/components/map/panels/styleEditor/editors/PropertyRow";
import type { PartRow } from "@/components/map/panels/styleEditor/editors/partRows";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { anchorTopOf, usePopover } from "@/components/map/panels/styleEditor/popovers/usePopover";
import {
  ChoiceRow,
  FormButton,
  NavRow,
  Row,
  SliderRow,
  TextRow,
} from "@/components/map/panels/styleEditor/rows";

const SIZE: PartRow = { type: "number", key: "size", label: "style_editor.size" };
const COLOR: PartRow = { type: "color", key: "color", label: "style_editor.color" };
const FONT: PartRow = {
  type: "choice",
  key: "font.weight",
  label: "style_editor.font",
  values: ["regular", "bold"],
};
const HALO: PartRow = { type: "color", key: "halo.color", label: "style_editor.halo" };
const HALO_WIDTH: PartRow = { type: "number", key: "halo.width", label: "style_editor.halo_width" };
const MAX_WIDTH: PartRow = { type: "number", key: "max_width", label: "style_editor.max_width" };
const OVERLAP: PartRow = {
  type: "switch",
  key: "allow_overlap",
  label: "style_editor.overlap",
  note: "style_editor.note_label_overlap",
};
/** Polygons take one placement (`inside`), so they get no row. */
const PLACEMENT: Record<Geometry, PartRow | undefined> = {
  point: {
    type: "choice",
    key: "placement",
    label: "style_editor.placement",
    values: ["auto", "above", "center"],
    fallback: "auto",
  },
  line: {
    type: "choice",
    key: "placement",
    label: "style_editor.placement",
    values: ["line", "center"],
    fallback: "line",
  },
  polygon: undefined,
};

function TextPicker({ value, onPick }: { value?: string; onPick: (field: string | null) => void }) {
  const { t } = useTranslation("common");
  const { fields } = useStyleData();
  return (
    <>
      <MenuItem dense onClick={() => onPick(null)}>
        <ListItemText
          primary={t("style_editor.custom_text")}
          secondary={t("style_editor.custom_text_sub")}
          secondaryTypographyProps={{ variant: "caption" }}
        />
      </MenuItem>
      <FieldPicker fields={fields} value={value} onChange={onPick} />
    </>
  );
}

function TextRows({ base }: { base: Path }) {
  const { t, i18n } = useTranslation("common");
  const store = useEditor();
  const data = useStyleData();
  const popover = usePopover();
  // In class scope the text is the class's own (label.text varies per feature); the number format is the layer's.
  const scopedText = useScoped(`${base}.text`);
  const textPath = scopedText.writePath;
  const text = scopedText.value;
  const issues = useIssueAt(textPath);
  const format = useStyleValue<NumberFormatSpec | undefined>(`${base}.format`);
  const formats = useStyleValue<Record<string, NumberFormatSpec> | undefined>(`${base}.formats`);
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

  const pickText = (anchor: HTMLElement) =>
    popover.open("picker", {
      key: "label:text",
      title: label,
      anchorTop: anchorTopOf(anchor),
      anchorEl: anchor,
      render: () => (
        <TextPicker
          value={field ?? undefined}
          onPick={(name) => {
            if (name === null) setCustom(true);
            else {
              setCustom(false);
              store.set(textPath, fieldToken(name));
            }
            popover.close("picker");
          }}
        />
      ),
    });
  const insertField = (anchor: HTMLElement) =>
    popover.open("picker", {
      key: "label:insert",
      title: t("style_editor.insert_field"),
      anchorTop: anchorTopOf(anchor),
      anchorEl: anchor,
      render: () => (
        <FieldPicker
          fields={data.fields}
          onChange={(name) => {
            store.set(textPath, `${(store.get(textPath) as string | undefined) ?? ""}${fieldToken(name)}`);
            popover.close("picker");
          }}
        />
      ),
    });

  const preview = fillTemplate(template, data.sample, data.fieldTypes, format ?? {}, i18n.language, formats);
  return (
    <>
      <Row label={label}>
        <FormButton
          text={
            custom
              ? t("style_editor.custom_text")
              : field !== null
                ? fieldLabel(field)
                : template || t("style_editor.no_text")
          }
          onOpen={pickText}
        />
      </Row>
      {custom && (
        <>
          <TextRow
            label={t("style_editor.template")}
            multiline
            value={template}
            placeholder={t("style_editor.template_placeholder")}
            note={t("style_editor.template_note")}
            onChange={(value) => store.set(textPath, value || undefined)}
          />
          <Row>
            <Button size="small" color="inherit" onClick={(event) => insertField(event.currentTarget)}>
              {t("style_editor.insert_field")}
            </Button>
          </Row>
        </>
      )}
      {issues.map((issue, i) => (
        <IssueNotice key={`${issue.code}-${i}`} issue={issue} />
      ))}
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
            label={t("style_editor.numbers_in", { field: fieldLabel(name) })}
            value={
              formats?.[name]
                ? t("style_editor.example", {
                    value: formatNumberText(
                      PREVIEW_NUMBER,
                      { ...(format ?? {}), ...formats[name] },
                      i18n.language
                    ),
                  })
                : t("style_editor.as_all_numbers")
            }
            onOpen={(anchor) =>
              popover.open(2, {
                key: `label:format:${name}`,
                title: t("style_editor.numbers_in", { field: fieldLabel(name) }),
                anchorTop: anchorTopOf(anchor),
                render: () => <NumberFormatEditor path={`${base}.formats.${name}`} />,
              })
            }
          />
        ))}
      {templateLines > 1 && !scopedText.scoped && (
        <NavRow
          label={t("style_editor.line_styles")}
          value={t("style_editor.lines_n", { n: templateLines })}
          onOpen={(anchor) =>
            popover.open(2, {
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
              ? t("style_editor.example", { value: formatNumberText(PREVIEW_NUMBER, format, i18n.language) })
              : t("style_editor.as_in_dataset")
          }
          onOpen={(anchor) =>
            popover.open(2, {
              key: "label:format",
              title: t("style_editor.number_format"),
              anchorTop: anchorTopOf(anchor),
              render: () => <NumberFormatEditor path={`${base}.format`} />,
            })
          }
        />
      )}
    </>
  );
}

function OffsetRows({ base }: { base: Path }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { value: offset, writePath: path } = useScoped(`${base}.offset`);
  // An offset by zoom has no sliders here.
  if (offset !== undefined && !Array.isArray(offset)) return null;
  const [x, y] = (Array.isArray(offset) ? offset : [0, 0]) as [number, number];
  const range = SLIDERS["label.offset"];
  const write = (next: [number, number]) =>
    store.set(path, next[0] === 0 && next[1] === 0 ? undefined : next);
  return (
    <>
      <SliderRow
        label={t("style_editor.offset_x")}
        min={range.min}
        max={range.max}
        step={range.step}
        unit={range.unit}
        value={x}
        onChange={(v) => write([v, y])}
      />
      <SliderRow
        label={t("style_editor.offset_y")}
        min={range.min}
        max={range.max}
        step={range.step}
        unit={range.unit}
        value={y}
        onChange={(v) => write([x, v])}
      />
    </>
  );
}

function PriorityRow({ base }: { base: Path }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const { fields } = useStyleData();
  const path = `${base}.priority`;
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
            { value: `largest:${f.name}`, label: t("style_editor.priority_largest", { field: f.label }) },
            { value: `smallest:${f.name}`, label: t("style_editor.priority_smallest", { field: f.label }) },
          ]),
      ]}
      onChange={(value) => {
        const at = value.indexOf(":");
        store.set(path, at < 0 ? undefined : { field: value.slice(at + 1), top: value.slice(0, at) });
      }}
    />
  );
}

export function LabelEditor({ base }: { base: Path }) {
  const { geometry } = useStyleData();
  const overlap = useStyleValue<unknown>(`${base}.allow_overlap`);
  const scoped = useScope() !== null;
  const placement = geometry ? PLACEMENT[geometry] : undefined;
  return (
    <>
      <TextRows base={base} />
      <PropertyRow row={SIZE} base={base} />
      <PropertyRow row={COLOR} base={base} />
      <PropertyRow row={FONT} base={base} />
      <PropertyRow row={HALO} base={base} />
      <PropertyRow row={HALO_WIDTH} base={base} />
      <PropertyRow row={MAX_WIDTH} base={base} />
      {placement && <PropertyRow row={placement} base={base} />}
      <OffsetRows base={base} />
      {overlap !== true && !scoped && <PriorityRow base={base} />}
      <PropertyRow row={OVERLAP} base={base} />
    </>
  );
}
