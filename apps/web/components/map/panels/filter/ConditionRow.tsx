"use client";

// One condition of the filter. In the panel a row of its own: the field's kind and the condition as a sentence, which
// opens its editor beside the panel, a switch and a remove button; for a viewer the sentence alone. The editor (a
// popover of the panel) is headed by the field, which changes there, and holds the condition's fields
// (ConditionFields: the comparison, the value and the row's issues), each change going straight into the draft. A
// style rule's conditions are these rows and editors too, over the rule's own draft (RuleConditions.tsx).
import { Box, ButtonBase, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { type FilterIssue, rowIssues } from "@/lib/filter/issues";
import { type FilterCondition, type FilterRow, isCustomRow } from "@/lib/filter/model";
import { momentText } from "@/lib/filter/moments";
import { operatorsFor, rowToCql, takesValue } from "@/lib/filter/rows";
import type { FieldType } from "@/lib/style/compile/types";

import FieldKindIcon, { fieldIndicatorKind } from "@/components/common/FieldKindIcon";
import {
  ConditionFields,
  DAYS,
  RANGE,
  hasWildcard,
  issueText,
} from "@/components/map/panels/filter/ConditionFields";
import { RowShell } from "@/components/map/panels/filter/RowShell";
import { typeOfRow, useDraftRow, useFilterPanel } from "@/components/map/panels/filter/draft";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { anchorTopOf, useCloseWhenGone } from "@/components/map/panels/styleEditor/popovers/usePopover";

export { hasWildcard, issueText };

/** How many values of a list the sentence names before it says how many more. */
const LISTED = 3;

/** The value part of a row's sentence: a list, a range, a number of days, or the value. A date and time reads in the
 * browser's zone, as its box shows it. */
function valueText(row: FilterCondition, t: TFunction): string {
  const shown = (v: unknown) => (v === undefined || v === null ? "" : momentText(v));
  if (Array.isArray(row.value)) {
    const head = row.value.slice(0, LISTED).map(shown).join(", ");
    const more = row.value.length - LISTED;
    return more > 0 ? `${head} ${t("filter_panel.more", { count: more })}` : head;
  }
  if (!takesValue(row.op) || row.value === undefined || row.value === "") return "";
  if (RANGE.has(row.op))
    return t("filter_panel.range", { from: shown(row.value), to: shown(row.value2) || "…" });
  if (DAYS.has(row.op)) return t("filter_panel.days", { count: Number(row.value) });
  return shown(row.value);
}

/** The row as a sentence: "traffic is at least 1500". */
export const rowSentence = (row: FilterCondition, label: string, t: TFunction) =>
  [label, t(`filter_panel.op.${row.op}`), valueText(row, t)].filter(Boolean).join(" ");

/** A field's kind before its name. */
const kindIcon = (type: FieldType | undefined) =>
  type ? <FieldKindIcon kind={fieldIndicatorKind({ type })} /> : undefined;

/** A row's note: its first issue, else why it saves nothing yet. */
function useRowNote(row: FilterRow, type: FieldType | undefined, issues: readonly FilterIssue[]) {
  const { t } = useTranslation("common");
  if (issues.length)
    return (
      <Box component="span" sx={{ color: "error.main" }}>
        {issueText(t, issues[0])}
      </Box>
    );
  if (hasWildcard(row)) return t("filter_panel.wildcard");
  if (rowToCql(row, type, { orEmpty: true }) === null) return t("filter_panel.unfinished");
  return undefined;
}

export interface ConditionRowProps {
  row: FilterRow;
  /** The field's display name. */
  label: string;
  type: FieldType | undefined;
  issues: readonly FilterIssue[];
  canEdit: boolean;
  onOpen: (id: string, anchorTop: number) => void;
  /** Switches the row on or off; no switch without it. */
  onToggle?: (id: string) => void;
  /** The filter takes no further condition: switched off, the row cannot be switched on. */
  full?: boolean;
  /** Removes the row; no remove button without it. */
  onRemove?: (id: string) => void;
}

export const ConditionRow = memo(function ConditionRow({
  row,
  label,
  type,
  issues,
  canEdit,
  onOpen,
  onToggle,
  full,
  onRemove,
}: ConditionRowProps) {
  const { t } = useTranslation("common");
  const note = useRowNote(row, type, issues);
  const unfinished = rowToCql(row, type, { orEmpty: true }) === null;
  const value = valueText(row, t);
  return (
    <RowShell
      id={row.id}
      glyph={kindIcon(type)}
      note={note}
      title={rowSentence(row, label, t)}
      off={!row.enabled}
      draft={unfinished}
      canEdit={canEdit}
      onOpen={(anchor) => onOpen(row.id, anchorTopOf(anchor))}
      // A row that saves nothing has nothing to switch.
      onToggle={!unfinished && onToggle ? () => onToggle(row.id) : undefined}
      switchDisabled={full && !row.enabled}
      onRemove={onRemove && (() => onRemove(row.id))}>
      {/* The field stands out, the comparison steps back, the value reads plain. */}
      <Typography
        variant="body2"
        noWrap
        sx={{ fontWeight: 500, color: unfinished ? "text.secondary" : undefined }}>
        <Box component="span" sx={{ fontWeight: 700 }}>
          {label}
        </Box>{" "}
        <Box component="span" sx={{ color: "text.secondary" }}>
          {t(`filter_panel.op.${row.op}`)}
        </Box>
        {value && ` ${value}`}
      </Typography>
    </RowShell>
  );
});

/** A condition's field changed to another: the comparison stays where the new field takes it, the value goes. */
function useFieldChange(row: FilterRow | undefined) {
  const { actions, fields, operators = operatorsFor } = useFilterPanel();
  return useCallback(
    (field: string) => {
      if (!row || field === row.field) return;
      const allowed = operators(fields[field]);
      actions.update(row.id, {
        field,
        op: allowed.includes(row.op) ? row.op : allowed[0],
        value: undefined,
        value2: undefined,
        type: undefined,
      });
    },
    [row, actions, fields, operators]
  );
}

/** The row `id` of the draft when it is a condition. */
function useCondition(id: string): FilterRow | undefined {
  const found = useDraftRow(id);
  return found && !isCustomRow(found) ? found : undefined;
}

/** The head of a condition's editor: the field it is on, which opens the fields to change it. */
export function ConditionHeading({ id }: { id: string }) {
  const { t } = useTranslation("common");
  const { fields, fieldInfos } = useFilterPanel();
  const row = useCondition(id);
  const changeField = useFieldChange(row);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!row) return null;
  const label = fieldInfos.find((f) => f.name === row.field)?.label ?? row.field;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
      {kindIcon(typeOfRow(row, fields))}
      <ButtonBase
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        aria-label={`${t("style_editor.condition_field")}: ${label}`}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        sx={{
          minWidth: 0,
          height: 30,
          px: 2,
          ml: -1,
          gap: 1.5,
          borderRadius: 1.5,
          "&:hover, &.Mui-focusVisible": { bgcolor: "action.hover" },
        }}>
        <Typography variant="body1" fontWeight="bold" noWrap>
          {label || t("style_editor.condition_field")}
        </Typography>
        <Icon iconName={ICON_NAME.CHEVRON_DOWN} sx={{ fontSize: 11, color: "text.secondary" }} />
      </ButtonBase>
      <FieldPicker
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        fields={fieldInfos}
        value={row.field || undefined}
        onChange={changeField}
      />
    </Box>
  );
}

/** The editor of one condition, in a popover of the panel; it reads its row live and closes once the row is gone. */
export function ConditionEditor({ id }: { id: string }) {
  const { actions, fields, layerId, operators } = useFilterPanel();
  const row = useCondition(id);
  useCloseWhenGone(!row);
  const update = useCallback((patch: Partial<FilterCondition>) => actions.update(id, patch), [actions, id]);
  const type = row && typeOfRow(row, fields);
  const ops = useMemo(() => operators?.(type), [operators, type]);
  if (!row) return null;
  return (
    <Box sx={{ pt: 1 }}>
      <ConditionFields
        row={row}
        type={type}
        issues={rowIssues(row, fields)}
        layerId={layerId}
        ops={ops}
        onChange={update}
      />
    </Box>
  );
}
