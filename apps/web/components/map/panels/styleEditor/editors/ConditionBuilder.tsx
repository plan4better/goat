"use client";

// The condition of a rule (spec 6): one line per condition (a field, a short comparison, a value) under its heading,
// which turns into "Match all/any of these" once there are two; "Add a condition" under the last line. A row writes
// nothing until it is complete, so the builder keeps its rows itself and hands up the CQL2 once they read.
import { Box, Button, IconButton, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  type ConditionOp,
  type ConditionRow,
  type ConditionRows,
  operatorsFor,
  takesValue,
} from "@/lib/style/editor/conditions";

import FieldKindIcon, { fieldIndicatorKind } from "@/components/common/FieldKindIcon";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { FieldPickerButton } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { DropdownMenu } from "@/components/map/panels/styleEditor/popovers/DropdownMenu";
import { AddButton, ChoiceField } from "@/components/map/panels/styleEditor/rows";

export const EMPTY_ROW: ConditionRow = { field: "", op: "is" };

const NUMBER_TYPES = new Set(["number", "integer"]);
/** The comparison's column: room for its short labels ("is not", "between"). */
const COMPARE_WIDTH = 76;
/** The remove button's column. */
const REMOVE_WIDTH = 24;

const show = (value: unknown) =>
  value === undefined || value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value);

/** A heading of a rule's popover ("When", "Then"). */
export function RuleHeading({ children }: { children: string }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      fontWeight="bold"
      sx={{ display: "block", px: 3, pt: 4, pb: 2 }}>
      {children}
    </Typography>
  );
}

/** A condition's value: digits for a number field (a list of them for "in"), text for the others. */
function ValueInput({
  value,
  label,
  placeholder,
  numeric,
  onChange,
}: {
  value: unknown;
  label: string;
  placeholder: string;
  numeric: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <TextFieldInput
      value={show(value)}
      clearable={false}
      placeholder={placeholder}
      inputProps={{ "aria-label": label, inputMode: numeric ? "decimal" : "text" }}
      onChange={onChange}
    />
  );
}

/** "Match [all] of these": the rows' all or any, as one quiet line with a small menu. */
function MatchLine({
  match,
  onChange,
}: {
  match: ConditionRows["match"];
  onChange: (m: ConditionRows["match"]) => void;
}) {
  const { t } = useTranslation("common");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 3, pt: 4, pb: 2 }}>
      <Typography variant="caption" color="text.secondary" fontWeight="bold">
        {t("style_editor.match_lead")}
      </Typography>
      <Button
        variant="text"
        size="small"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-label={`${t("style_editor.match_lead")}: ${t(`style_editor.match_${match}`)}`}
        endIcon={<Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: "10px !important" }} />}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        sx={{ minWidth: 0, px: 1, py: 0, typography: "caption", fontWeight: 700 }}>
        {t(`style_editor.match_${match}_short`)}
      </Button>
      <Typography variant="caption" color="text.secondary" fontWeight="bold">
        {t("style_editor.match_tail")}
      </Typography>
      <DropdownMenu
        anchorEl={anchor}
        role="listbox"
        width={240}
        placement="bottom-start"
        items={(["all", "any"] as const).map((m) => ({
          label: t(`style_editor.match_${m}`),
          sub: t(`style_editor.match_${m}_sub`),
          selected: m === match,
          onClick: () => onChange(m),
        }))}
        onClose={() => setAnchor(null)}
      />
    </Box>
  );
}

export function ConditionBuilder({
  rows,
  onChange,
  title,
}: {
  rows: ConditionRows;
  onChange: (rows: ConditionRows) => void;
  /** The heading over a single condition ("When"); two or more say whether all or any must hold instead. */
  title: string;
}) {
  const { t } = useTranslation("common");
  const { fields, fieldTypes } = useStyleData();
  const many = rows.rows.length > 1;
  const setRow = (i: number, patch: Partial<ConditionRow>) =>
    onChange({ ...rows, rows: rows.rows.map((row, j) => (j === i ? { ...row, ...patch } : row)) });
  return (
    <>
      {many ? (
        <MatchLine match={rows.match} onChange={(match) => onChange({ ...rows, match })} />
      ) : (
        <RuleHeading>{title}</RuleHeading>
      )}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2, px: 3 }}>
        {rows.rows.map((row, i) => {
          const type = fieldTypes[row.field];
          const ops = operatorsFor(type);
          const label = fields.find((f) => f.name === row.field)?.label ?? row.field;
          const valued = takesValue(row.op);
          const numeric = NUMBER_TYPES.has(type ?? "");
          return (
            <Box
              key={i}
              role="group"
              aria-label={t("style_editor.condition_n", { n: i + 1 })}
              sx={{
                display: "grid",
                // The field widest, the comparison as wide as its short labels, the value the rest; a comparison
                // without a value gives its room to the field.
                gridTemplateColumns: `minmax(0, 1.3fr) ${COMPARE_WIDTH}px ${valued ? "minmax(0, 1fr)" : ""}${
                  many ? ` ${REMOVE_WIDTH}px` : ""
                }`,
                columnGap: 2,
                alignItems: "start",
              }}>
              <FieldPickerButton
                ariaLabel={t("style_editor.condition_field")}
                start={type && <FieldKindIcon kind={fieldIndicatorKind({ type })} />}
                text={label || t("style_editor.condition_field")}
                fields={fields}
                value={row.field || undefined}
                onChange={(field) => {
                  const allowed = operatorsFor(fieldTypes[field]);
                  setRow(i, {
                    field,
                    op: allowed.includes(row.op) ? row.op : allowed[0],
                    value: undefined,
                    value2: undefined,
                  });
                }}
              />
              <ChoiceField<string>
                ariaLabel={t("style_editor.condition_compare")}
                value={row.op}
                options={ops.map((op) => ({
                  value: op,
                  label: t(`filter_expressions.${op}`),
                  short: t(`style_editor.op_short_${op}`),
                }))}
                onChange={(op) => setRow(i, { op: op as ConditionOp })}
              />
              {valued && (
                <Box sx={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <ValueInput
                    value={row.value}
                    label={t("style_editor.condition_value")}
                    placeholder={t("style_editor.condition_value")}
                    numeric={numeric}
                    onChange={(value) => setRow(i, { value })}
                  />
                  {row.op === "is_between" && (
                    <ValueInput
                      value={row.value2}
                      label={t("style_editor.condition_value_to")}
                      placeholder={t("style_editor.condition_value_to")}
                      numeric={numeric}
                      onChange={(value2) => setRow(i, { value2 })}
                    />
                  )}
                </Box>
              )}
              {many && (
                // Centred on the line's fields (40 px).
                <IconButton
                  size="small"
                  aria-label={t("style_editor.remove_condition")}
                  onClick={() => onChange({ ...rows, rows: rows.rows.filter((_, j) => j !== i) })}
                  sx={{ width: REMOVE_WIDTH, height: REMOVE_WIDTH, mt: 2 }}>
                  <Icon iconName={ICON_NAME.CLOSE} sx={{ fontSize: 12 }} />
                </IconButton>
              )}
            </Box>
          );
        })}
        {/* Under the last condition, its plus on the content's edge. */}
        <AddButton onClick={() => onChange({ ...rows, rows: [...rows.rows, EMPTY_ROW] })} sx={{ ml: -2.5 }}>
          {t("style_editor.add_condition")}
        </AddButton>
      </Box>
    </>
  );
}
