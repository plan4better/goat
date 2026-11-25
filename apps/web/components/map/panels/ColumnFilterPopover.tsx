import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { Box, Button, Divider, Popover, Stack, Typography } from "@mui/material";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { v4 } from "uuid";

import { rowIssues } from "@/lib/filter/issues";
import { type FilterCondition, type FilterOp, type FilterRow, isCustomRow } from "@/lib/filter/model";
import { operatorsFor, rowToCql } from "@/lib/filter/rows";
import { writeFilter } from "@/lib/filter/write";
import type { FieldType } from "@/lib/style/compile/types";

import type { TableFilterController } from "@/types/map/tableFilter";

import FieldKindIcon, { type FieldIndicatorKind } from "@/components/common/FieldKindIcon";
import { ConditionFields, picksValues } from "@/components/map/panels/filter/ConditionFields";
import { rowSentence } from "@/components/map/panels/filter/ConditionRow";
import { typeOfRow } from "@/components/map/panels/filter/draft";

const POPOVER_WIDTH = 300;
const MAX_POPOVER_HEIGHT = 460;
/** Below this, the value list is too cramped to be worth opening downward. */
const MIN_USABLE_HEIGHT = 300;
const VIEWPORT_MARGIN = 16;

/** A refused save's messages: the server's, else the error's own. */
const messagesOf = (error: unknown): string[] => {
  const messages = (error as { messages?: unknown } | null)?.messages;
  if (Array.isArray(messages) && messages.length) return messages.map(String);
  return [error instanceof Error ? error.message : String(error)];
};

/**
 * The comparisons a column offers: the Filter panel's, without includes and
 * excludes. Picking a second value for is / is not turns the row into those.
 */
const columnOps = (type: FieldType | undefined): FilterOp[] =>
  operatorsFor(type).filter((op) => op !== "includes" && op !== "excludes");

/**
 * Whether a table offers its column filter on `column`: only to someone who
 * may change the host's filters, and only on a field the filter has a type
 * for (a row on any other could never be saved).
 */
export const canFilterColumn = (controller: TableFilterController, column: string): boolean =>
  controller.canEdit && Object.prototype.hasOwnProperty.call(controller.fields, column);

type ColumnFilterPopoverProps = {
  anchorEl: HTMLElement | null;
  columnName: string;
  iconKind: FieldIndicatorKind;
  layerId: string;
  controller: TableFilterController;
  onClose: () => void;
};

const ColumnFilterPopover: React.FC<ColumnFilterPopoverProps> = ({
  anchorEl,
  columnName,
  iconKind,
  layerId,
  controller,
  onClose,
}) => {
  const { t } = useTranslation("common");
  const { model, fields, canEdit } = controller;

  const columnRows = useMemo(
    () => model.rows.filter((row): row is FilterRow => !isCustomRow(row) && row.field === columnName),
    [model.rows, columnName]
  );

  /**
   * The popover owns one row per column: the first switched-on one with a
   * comparison the column offers. Anything else on the column (a switched-off
   * row, a comparison of another type) is left alone and reported instead of
   * being overwritten. A custom row names no single column.
   */
  const ownedRow = useMemo(
    () => columnRows.find((row) => row.enabled && operatorsFor(typeOfRow(row, fields)).includes(row.op)),
    [columnRows, fields]
  );

  const otherRowCount = columnRows.length - (ownedRow ? 1 : 0);

  // Edited here until Done: nothing is saved while the popover is open.
  const [row, setRow] = useState<FilterRow>(() => {
    if (ownedRow) return ownedRow;
    const op = columnOps(typeOfRow({ field: columnName, op: "is" }, fields))[0];
    return { id: v4(), field: columnName, op, enabled: true };
  });
  const type = typeOfRow(row, fields);
  const ops = useMemo(() => columnOps(type), [type]);
  const issues = rowIssues(row, fields);
  // A row that writes nothing (no value yet, a wildcard, no whole number of days) cannot be saved.
  const isReady = issues.length === 0 && rowToCql(row, type, { orEmpty: true }) !== null;
  const showsValues = canEdit && picksValues(row.op, type);
  const isSaving = useRef(false);

  /**
   * The data table docks to the bottom of the window, so a header near the
   * bottom leaves no room below it. MUI does not flip on its own: pick the
   * roomier side and cap the height to it.
   */
  const placement = useMemo(() => {
    if (!anchorEl || typeof window === "undefined") {
      return { anchor: "bottom", transform: "top", maxHeight: MAX_POPOVER_HEIGHT } as const;
    }
    const rect = anchorEl.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const above = rect.top - VIEWPORT_MARGIN;
    if (below >= MIN_USABLE_HEIGHT || below >= above) {
      return { anchor: "bottom", transform: "top", maxHeight: Math.min(MAX_POPOVER_HEIGHT, below) } as const;
    }
    return { anchor: "top", transform: "bottom", maxHeight: Math.min(MAX_POPOVER_HEIGHT, above) } as const;
  }, [anchorEl]);

  /**
   * Value lists are scoped by every other active filter but never this column's
   * own, so the list stays consistent with the table without hiding the values
   * already selected here.
   */
  const valueListFilter = useMemo(() => {
    const others = model.rows.filter((r) => isCustomRow(r) || r.field !== columnName);
    return writeFilter({ ...model, rows: others }, fields).cql;
  }, [model, fields, columnName]);

  const handleChange = useCallback(
    (patch: Partial<FilterCondition>) => setRow((previous) => ({ ...previous, ...patch })),
    []
  );

  const handleApply = useCallback(async () => {
    if (!isReady || isSaving.current) return;
    isSaving.current = true;
    onClose();
    try {
      await controller.upsert(row);
    } catch (error) {
      toast.error(messagesOf(error).join("\n"));
    }
  }, [isReady, row, controller, onClose]);

  const handleRemove = useCallback(async () => {
    if (!ownedRow) return;
    onClose();
    try {
      await controller.remove(ownedRow.id);
    } catch (error) {
      toast.error(messagesOf(error).join("\n"));
    }
  }, [ownedRow, controller, onClose]);

  return (
    <Popover
      open={!!anchorEl}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: placement.anchor, horizontal: "left" }}
      transformOrigin={{ vertical: placement.transform, horizontal: "left" }}
      slotProps={{
        paper: {
          sx: {
            width: POPOVER_WIDTH,
            my: 0.5,
            maxHeight: placement.maxHeight,
            // A value list arrives asynchronously, so a content-sized paper grows
            // once it loads. MUI re-positions on every render while open, and an
            // upward-opening popover is anchored by its bottom edge, so growing
            // would shift its top and the whole panel would appear to jump. Claim
            // the height up front and let the list scroll inside it instead.
            ...(showsValues && { height: placement.maxHeight }),
            display: "flex",
            flexDirection: "column",
          },
        },
      }}>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ px: 3, py: 2, flexShrink: 0 }}>
        <FieldKindIcon kind={iconKind} />
        <Typography variant="body2" fontWeight="bold" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {columnName}
        </Typography>
      </Stack>

      <Divider sx={{ flexShrink: 0 }} />

      {/* Only the body scrolls; the column and the actions stay put. A column, so
          a value list gives up height and scrolls on its own instead. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 2, display: "flex", flexDirection: "column" }}>
        {canEdit ? (
          <ConditionFields
            row={row}
            type={type}
            issues={issues}
            layerId={layerId}
            ops={ops}
            pickSeveral
            filter={valueListFilter}
            live
            onEnter={handleApply}
            onChange={handleChange}
          />
        ) : (
          columnRows.map((columnRow) => (
            <Typography key={columnRow.id} variant="body2" sx={{ px: 3, pt: 2 }}>
              {rowSentence(columnRow, columnName, t)}
            </Typography>
          ))
        )}
      </Box>

      {canEdit && otherRowCount > 0 && (
        <Stack
          direction="row"
          spacing={2}
          sx={{
            px: 3,
            py: 2,
            borderTop: 1,
            borderColor: "divider",
            bgcolor: "action.hover",
            flexShrink: 0,
          }}>
          <WarningAmberIcon sx={{ fontSize: 16, color: "warning.main", flexShrink: 0 }} />
          <Typography variant="caption" color="text.secondary">
            {t("column_has_other_filters", { count: otherRowCount, column: columnName })}
          </Typography>
        </Stack>
      )}

      <Divider sx={{ flexShrink: 0 }} />

      {/* Text buttons throughout, as in the widget's column popover and ConfirmModal. */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 2, flexShrink: 0 }}>
        {canEdit && ownedRow && (
          <Button variant="text" color="error" onClick={handleRemove}>
            <Typography variant="body2" fontWeight="bold" color="inherit">
              {t("remove")}
            </Typography>
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button variant="text" onClick={onClose}>
          <Typography variant="body2" fontWeight="bold">
            {canEdit ? t("cancel") : t("close")}
          </Typography>
        </Button>
        {canEdit && (
          <Button variant="text" color="primary" disabled={!isReady} onClick={handleApply}>
            <Typography variant="body2" fontWeight="bold" color="inherit">
              {t("done")}
            </Typography>
          </Button>
        )}
      </Stack>
    </Popover>
  );
};

export default ColumnFilterPopover;
