"use client";

// The fields of one condition, free of the filter panel: the comparison, the value (the field's values to pick for is,
// is not, includes and excludes, a slider over the histogram for a comparison of numbers, a box to type into for the
// others) and the row's issues under them. A change comes back as a patch of the row; the holder decides when it
// counts. A typed value counts once the box is left, Enter is pressed or typing pauses, so typing sends nothing per key;
// a holder that saves only on its own button (the data table's column filter) takes every key at once instead.
import { Box, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FilterIssue } from "@/lib/filter/issues";
import type { FilterCondition, FilterOp } from "@/lib/filter/model";
import { operatorsFor, takesValue } from "@/lib/filter/rows";
import type { FieldType } from "@/lib/style/compile/types";
import type { JsonObject } from "@/lib/style/json";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import { NumberSlider, SLIDER_MODES } from "@/components/map/panels/filter/NumberSlider";
import { ValuePicker } from "@/components/map/panels/filter/ValuePicker";
import { ChoiceField, Row } from "@/components/map/panels/styleEditor/rows";

/** The pause after the last key before a typed value counts. */
export const TYPING_PAUSE = 600;

const TEXT_SEARCH = new Set<FilterOp>([
  "contains_the_text",
  "does_not_contains_the_text",
  "starts_with",
  "ends_with",
]);
const PICKED = new Set<FilterOp>(["is", "is_not", "includes", "excludes"]);
export const RANGE = new Set<FilterOp>(["is_between", "is_not_between"]);
export const DAYS = new Set<FilterOp>(["in_the_last", "not_in_the_last"]);

const numeric = (type: FieldType | undefined) => type === "number" || type === "integer";
const temporal = (type: FieldType | undefined) => type === "date" || type === "datetime";

/** A text to search with `%` or `_` in it: the filter cannot say it (they are wildcards), so the row saves nothing. */
export const hasWildcard = (row: FilterCondition) =>
  TEXT_SEARCH.has(row.op) && typeof row.value === "string" && /[%_]/.test(row.value);

/** An issue's message. */
export const issueText = (t: TFunction, issue: FilterIssue) =>
  t(`filter_panel.issue_${issue.code}`, { field: issue.field ?? "", limit: issue.limit ?? 0 });

type InputKind = "text" | "number" | "days" | "date" | "datetime";

/** A value as its box shows it. */
function toText(value: unknown, kind: InputKind): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (kind !== "datetime") return text;
  // A day reads as its start; a moment to the minute.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00`;
  return text.slice(0, 16);
}

/** A box's text as the row's value: undefined while there is none (or no number in a number box). */
function fromText(text: string, kind: InputKind): unknown {
  if (!text.trim()) return undefined;
  switch (kind) {
    case "number": {
      const n = Number(text.trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case "days": {
      const n = Number(text.trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
    case "datetime":
      // The start of a day is that day; another moment is written in UTC.
      return text.endsWith("T00:00") ? text.slice(0, 10) : `${text}:00Z`;
    default:
      return text;
  }
}

/** A value typed into a box, kept as typed until it counts. A text `refuse` names a reason for is kept in the box
 * with the reason under it and never counts. `live` counts every key at once. */
export const CommitInput = memo(function CommitInput({
  value,
  kind,
  ariaLabel,
  onCommit,
  refuse,
  live,
  onEnter,
}: {
  value: unknown;
  kind: InputKind;
  ariaLabel: string;
  onCommit: (value: unknown) => void;
  refuse?: (text: string) => string | undefined;
  live?: boolean;
  /** After Enter has committed the box. */
  onEnter?: () => void;
}) {
  const shown = toText(value, kind);
  const [text, setText] = useState(shown);
  // The value changed elsewhere (another field, an undo of the server): the box shows it. Live, the change may be the
  // box's own text (a number half typed counts as none yet), which then stays as typed.
  const [seen, setSeen] = useState(shown);
  if (seen !== shown) {
    setSeen(shown);
    if (!live || toText(fromText(text, kind), kind) !== shown) setText(shown);
  }
  const latest = useRef({ shown, onCommit, kind, refuse, onEnter });
  latest.current = { shown, onCommit, kind, refuse, onEnter };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (next: string) => {
    clearTimeout(timer.current);
    if (next === latest.current.shown || latest.current.refuse?.(next)) return;
    latest.current.onCommit(fromText(next, latest.current.kind));
  };
  const refused = refuse?.(text);
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <TextFieldInput
        value={text}
        clearable={false}
        type={kind === "date" ? "date" : "text"}
        inputProps={{
          "aria-label": ariaLabel,
          inputMode: kind === "number" ? "decimal" : kind === "days" ? "numeric" : undefined,
          autoComplete: "off",
          ...(kind === "datetime" ? { type: "datetime-local" } : {}),
          onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key !== "Enter") return;
            commit(event.currentTarget.value);
            latest.current.onEnter?.();
          },
        }}
        onChange={(next) => {
          setText(next);
          clearTimeout(timer.current);
          if (live) commit(next);
          else timer.current = setTimeout(() => commit(next), TYPING_PAUSE);
        }}
        onBlur={() => commit(text)}
      />
      {refused && (
        <Typography variant="caption" color="error" sx={{ display: "block", pt: 1 }}>
          {refused}
        </Typography>
      )}
    </Box>
  );
});

/** The box kind of an operator on a field of `type`. */
function inputKind(op: FilterOp, type: FieldType | undefined): InputKind {
  if (DAYS.has(op)) return "days";
  if (type === "datetime" && op !== "is_on" && op !== "is_not_on") return "datetime";
  if (temporal(type)) return "date";
  return numeric(type) ? "number" : "text";
}

/** Whether the value of `op` on a field of `type` is picked from the field's values rather than typed. */
export const picksValues = (op: FilterOp, type: FieldType | undefined) =>
  PICKED.has(op) && !temporal(type) && type !== "boolean";

/** The value part of the fields. */
function ValueRows({
  row,
  type,
  layerId,
  onChange,
  several,
  filter,
  live,
  onEnter,
}: Pick<ConditionFieldsProps, "row" | "type" | "layerId" | "onChange" | "filter" | "live" | "onEnter"> & {
  /** is and is not pick several values too. */
  several?: boolean;
}) {
  const { t } = useTranslation("common");
  if (!takesValue(row.op)) return null;
  const valueLabel = t("style_editor.condition_value");
  if (picksValues(row.op, type)) {
    const multiple = several || row.op === "includes" || row.op === "excludes";
    return (
      // Another field or another kind of pick starts the list afresh (its search, its pages, the values on top).
      <ValuePicker
        key={`${row.field}|${multiple}`}
        layerId={layerId}
        field={row.field}
        type={type}
        multiple={multiple}
        value={row.value}
        ariaLabel={valueLabel}
        filter={filter}
        onChange={(value) => onChange({ value })}
      />
    );
  }
  const kind = inputKind(row.op, type);
  // A text search cannot take % or _ (the filter's wildcards): the box keeps such a text and says so. Live, the text
  // counts as typed and the issue lines under the fields say it.
  const refuse =
    !live && TEXT_SEARCH.has(row.op)
      ? (text: string) => (/[%_]/.test(text) ? t("filter_panel.wildcard") : undefined)
      : undefined;
  return (
    <>
      {/* A comparison of numbers: a slider over the field's histogram, the boxes under it for an exact value. */}
      {layerId && numeric(type) && SLIDER_MODES[row.op] && (
        <NumberSlider
          layerId={layerId}
          field={row.field}
          op={row.op}
          integer={type === "integer"}
          value={row.value}
          value2={row.value2}
          onChange={(value, value2) => onChange(RANGE.has(row.op) ? { value, value2 } : { value })}
        />
      )}
      <Row label={DAYS.has(row.op) ? t("number_of_days") : valueLabel}>
        <CommitInput
          value={row.value}
          kind={kind}
          ariaLabel={valueLabel}
          refuse={refuse}
          live={live}
          onEnter={onEnter}
          onCommit={(value) => onChange({ value })}
        />
      </Row>
      {RANGE.has(row.op) && (
        <Row label={t("style_editor.condition_value_to")}>
          <CommitInput
            value={row.value2}
            kind={kind}
            ariaLabel={t("style_editor.condition_value_to")}
            live={live}
            onEnter={onEnter}
            onCommit={(value2) => onChange({ value2 })}
          />
        </Row>
      )}
    </>
  );
}

/** Whether a row's value fits the box of another operator, so changing the comparison keeps it. */
const sameBox = (a: FilterOp, b: FilterOp, type: FieldType | undefined) =>
  takesValue(a) &&
  takesValue(b) &&
  PICKED.has(a) === PICKED.has(b) &&
  (a === "includes" || a === "excludes") === (b === "includes" || b === "excludes") &&
  inputKind(a, type) === inputKind(b, type);

export interface ConditionFieldsProps {
  row: FilterCondition;
  /** The type the row's value is read and written with. */
  type: FieldType | undefined;
  issues: readonly FilterIssue[];
  onChange: (patch: Partial<FilterCondition>) => void;
  /** The dataset the value lists and the histogram are read from; without it values are typed. */
  layerId?: string;
  /** The comparisons offered, else every one the field's type has. */
  ops?: readonly FilterOp[];
  /** is and is not pick several values, becoming includes and excludes from two on (and back with one), so the
   * comparisons need not offer those two. */
  pickSeveral?: boolean;
  /** The value list lists and counts only the features this CQL keeps. */
  filter?: JsonObject;
  /** A typed value counts at every key. */
  live?: boolean;
  /** Enter in a box, after it has counted. */
  onEnter?: () => void;
}

/** What is and is not become with several values, and back. */
const SEVERAL: Partial<Record<FilterOp, FilterOp>> = { is: "includes", is_not: "excludes" };
const ONE: Partial<Record<FilterOp, FilterOp>> = { includes: "is", excludes: "is_not" };

/** A patch with is and is not over several values as includes and excludes, and the other way with one or none. */
function foldSeveral(row: FilterCondition, patch: Partial<FilterCondition>): Partial<FilterCondition> {
  const next = { ...row, ...patch };
  const one = ONE[next.op] ?? next.op;
  const several = SEVERAL[one];
  if (!several) return patch;
  const values = Array.isArray(next.value) ? next.value : undefined;
  if (values && values.length > 1) return { ...patch, op: several };
  return { ...patch, op: one, value: values ? values[0] : next.value };
}

/** The comparison, the value and the issues of one condition. */
export function ConditionFields({
  row,
  type,
  issues,
  onChange,
  layerId,
  ops: offered,
  pickSeveral,
  filter,
  live,
  onEnter,
}: ConditionFieldsProps) {
  const { t } = useTranslation("common");
  const ops = useMemo(() => offered ?? operatorsFor(type), [offered, type]);
  const options = useMemo(
    () => ops.map((op) => ({ value: op, label: t(`filter_panel.op.${op}`) })),
    [ops, t]
  );
  // Picking several, includes and excludes read as the is and is not they came from.
  const op = pickSeveral ? (ONE[row.op] ?? row.op) : row.op;
  const change = (patch: Partial<FilterCondition>) => onChange(pickSeveral ? foldSeveral(row, patch) : patch);
  return (
    <>
      <Row label={t("filter_panel.condition")}>
        <ChoiceField<FilterOp>
          ariaLabel={t("style_editor.condition_compare")}
          value={op}
          options={options}
          onChange={(next) =>
            change(sameBox(op, next, type) ? { op: next } : { op: next, value: undefined, value2: undefined })
          }
        />
      </Row>
      <ValueRows
        row={row}
        type={type}
        layerId={layerId}
        onChange={change}
        several={pickSeveral}
        filter={filter}
        live={live}
        onEnter={onEnter}
      />
      {(issues.length > 0 || hasWildcard(row)) && (
        <Box sx={{ px: 3, pt: 2 }}>
          {issues.map((issue) => (
            <Typography key={issue.code} variant="caption" color="error" sx={{ display: "block" }}>
              {issueText(t, issue)}
            </Typography>
          ))}
          {hasWildcard(row) && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {t("filter_panel.wildcard")}
            </Typography>
          )}
        </Box>
      )}
    </>
  );
}
