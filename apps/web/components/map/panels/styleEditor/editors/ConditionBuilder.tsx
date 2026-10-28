"use client";

// The condition of a rule as rows (spec 6): a field, what it must be and a value; all or any of the rows. A row
// writes nothing until it is complete, so the builder keeps its rows itself and hands up the CQL2 once they read.
import { Box, Button, IconButton } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import {
  type ConditionOp,
  type ConditionRow,
  type ConditionRows,
  operatorsFor,
  takesValue,
} from "@/lib/style/editor/conditions";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { ChoiceRow, Row } from "@/components/map/panels/styleEditor/rows";

export const EMPTY_ROW: ConditionRow = { field: "", op: "is" };

const show = (value: unknown) =>
  value === undefined || value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value);

function ValueInput({
  value,
  label,
  onChange,
}: {
  value: unknown;
  label: string;
  onChange: (v: string) => void;
}) {
  return (
    <TextFieldInput
      value={show(value)}
      clearable={false}
      inputProps={{ "aria-label": label }}
      onChange={onChange}
    />
  );
}

export function ConditionBuilder({
  rows,
  onChange,
}: {
  rows: ConditionRows;
  onChange: (rows: ConditionRows) => void;
}) {
  const { t } = useTranslation("common");
  const { fields, fieldTypes } = useStyleData();
  const setRow = (i: number, patch: Partial<ConditionRow>) =>
    onChange({ ...rows, rows: rows.rows.map((row, j) => (j === i ? { ...row, ...patch } : row)) });
  return (
    <>
      {rows.rows.length > 1 && (
        <ChoiceRow<string>
          label={t("style_editor.match")}
          value={rows.match}
          options={["all", "any"].map((v) => ({
            value: v,
            label: t(`style_editor.match_${v}`),
            sub: t(`style_editor.match_${v}_sub`),
          }))}
          onChange={(match) => onChange({ ...rows, match: match as ConditionRows["match"] })}
        />
      )}
      {rows.rows.map((row, i) => {
        const ops = operatorsFor(fieldTypes[row.field]);
        return (
          <Box key={i} sx={{ pb: 1, borderBottom: 1, borderColor: "divider" }}>
            <ChoiceRow<string>
              label={t("style_editor.condition_field")}
              value={row.field}
              options={[
                ...(row.field ? [] : [{ value: "", label: t("style_editor.pick_field") }]),
                ...fields.map((f) => ({ value: f.name, label: f.label })),
              ]}
              mode={
                rows.rows.length > 1 ? (
                  <IconButton
                    size="small"
                    aria-label={t("style_editor.remove_condition")}
                    onClick={() => onChange({ ...rows, rows: rows.rows.filter((_, j) => j !== i) })}>
                    <Icon iconName={ICON_NAME.TRASH} sx={{ fontSize: 12 }} />
                  </IconButton>
                ) : undefined
              }
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
            <ChoiceRow<string>
              label={t("style_editor.condition_operator")}
              value={row.op}
              options={ops.map((op) => ({ value: op, label: t(`filter_expressions.${op}`) }))}
              onChange={(op) => setRow(i, { op: op as ConditionOp })}
            />
            {takesValue(row.op) && (
              <Row label={t("style_editor.condition_value_label")}>
                <ValueInput
                  value={row.value}
                  label={t("style_editor.condition_value")}
                  onChange={(value) => setRow(i, { value })}
                />
                {row.op === "is_between" && (
                  <ValueInput
                    value={row.value2}
                    label={t("style_editor.condition_value_to")}
                    onChange={(value2) => setRow(i, { value2 })}
                  />
                )}
              </Row>
            )}
          </Box>
        );
      })}
      <Box sx={{ px: 3, pt: 1 }}>
        <Button
          size="small"
          color="inherit"
          onClick={() => onChange({ ...rows, rows: [...rows.rows, EMPTY_ROW] })}>
          {t("style_editor.add_condition")}
        </Button>
      </Box>
    </>
  );
}
