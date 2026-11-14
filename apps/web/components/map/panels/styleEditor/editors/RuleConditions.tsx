"use client";

// The condition of a rule (spec 6), made of the filter panel's parts: the conditions are the rows of a filter draft
// (draft.ts), each a row as the filter panel's (ConditionRow: the field's kind and the condition as a sentence) that
// opens its editor one level further (ConditionHeading, ConditionEditor), matched all or any with the panel's menu
// from two conditions on, "Add a condition" picking the field first. What differs is said through the panel's context:
// the style's comparisons (no relative dates) and the layer's fields and values. The holder decides what the draft
// writes (lib/style/editor/conditions.ts, in the style's spelling).
import { Box, Typography } from "@mui/material";
import { type ReactNode, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { type FilterIssue, rowIssues } from "@/lib/filter/issues";
import { type FilterModel, type FilterRow, isCustomRow } from "@/lib/filter/model";
import { type ConditionRows, operatorsFor } from "@/lib/style/editor/conditions";

import { ConditionEditor, ConditionHeading, ConditionRow } from "@/components/map/panels/filter/ConditionRow";
import { MatchMenu } from "@/components/map/panels/filter/MatchMenu";
import { editorKey } from "@/components/map/panels/filter/RowShell";
import {
  type DraftAction,
  type DraftActions,
  DraftStore,
  FilterPanelContext,
  type FilterPanelContextValue,
  reduceDraft,
  typeOfRow,
} from "@/components/map/panels/filter/draft";
import { useStyleData } from "@/components/map/panels/styleEditor/context";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { AddButton } from "@/components/map/panels/styleEditor/rows";

const NONE: readonly FilterIssue[] = [];

/** A heading of a rule's popover ("When", "Then"), with a control of its own at its end. */
export function RuleHeading({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 3, pt: 4, pb: 2, minHeight: 24 }}>
      <Typography variant="caption" color="text.secondary" fontWeight="bold" sx={{ flex: 1, minWidth: 0 }}>
        {children}
      </Typography>
      {action}
    </Box>
  );
}

/** A rule's conditions as a filter draft, and what changes it. */
export interface ConditionDraft {
  store: DraftStore;
  actions: DraftActions;
  /** An id no row of the draft has. */
  newId: () => string;
  /** Replaces the rows (an edit elsewhere: an undo, the CQL2 text). */
  reset: (rows: ConditionRows | null) => void;
}

/** The draft's rows as conditions.ts writes them: a rule's draft holds conditions only. */
export const draftRows = (model: FilterModel) => ({
  match: model.match,
  rows: model.rows.filter((row): row is FilterRow => !isCustomRow(row)),
});

/** A draft of the rows `initial` gives; `onChange` hears each change made through the actions. */
export function useConditionDraft(
  initial: () => ConditionRows | null,
  onChange?: (model: FilterModel) => void
): ConditionDraft {
  const latest = useRef(onChange);
  latest.current = onChange;
  const [draft] = useState<ConditionDraft>(() => {
    let count = 0;
    const newId = () => `c${(count += 1)}`;
    const toModel = (rows: ConditionRows | null): FilterModel => ({
      match: rows?.match ?? "all",
      rows: (rows?.rows ?? []).map((row) => ({ ...row, id: newId(), enabled: true })),
    });
    const store = new DraftStore(toModel(initial()));
    const dispatch = (action: DraftAction) => {
      const prev = store.get();
      const next = reduceDraft(prev, action);
      if (next === prev) return;
      store.set(next);
      latest.current?.(next);
    };
    const actions: DraftActions = {
      update: (id, patch) => dispatch({ type: "update", id, patch }),
      // A rule keeps one condition at least.
      remove: (id) => {
        if (store.get().rows.length > 1) dispatch({ type: "remove", id });
      },
      toggle: (id) => dispatch({ type: "toggle", id }),
      setMatch: (match) => dispatch({ type: "match", match }),
      add: (row) => dispatch({ type: "add", row }),
      // A rule has no area.
      setArea: () => undefined,
      clear: () => dispatch({ type: "clear" }),
    };
    return { store, actions, newId, reset: (rows) => store.set(toModel(rows)) };
  });
  return draft;
}

/** The filter panel's context over a rule's draft: the layer's fields, its dataset for the value lists and the
 * histogram, the style's comparisons. Around each condition's editor: it draws in the panel's popover stack, outside
 * the rule's popover. */
function ConditionScope({ draft, children }: { draft: ConditionDraft; children: ReactNode }) {
  const { layerId, fields, fieldTypes } = useStyleData();
  const value = useMemo<FilterPanelContextValue>(
    () => ({
      store: draft.store,
      actions: draft.actions,
      fields: fieldTypes,
      fieldInfos: fields,
      layerId: layerId || undefined,
      operators: operatorsFor,
    }),
    [draft, fieldTypes, fields, layerId]
  );
  return <FilterPanelContext.Provider value={value}>{children}</FilterPanelContext.Provider>;
}

/** "When": the rule's conditions, matched all or any from two on, and "Add a condition" under them. */
export function RuleConditions({ draft }: { draft: ConditionDraft }) {
  const { t } = useTranslation("common");
  const { fields, fieldTypes } = useStyleData();
  const popover = usePopover();
  const level = useNextLevel();
  const model = useSyncExternalStore(draft.store.subscribe, draft.store.get, draft.store.get);
  const rows = draftRows(model).rows;
  const labels = useMemo(() => new Map(fields.map((f) => [f.name, f.label])), [fields]);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  // A rule keeps one condition at least: with one, there is nothing to remove.
  const many = rows.length > 1;

  const openEditor = useCallback(
    (id: string, anchorTop: number) =>
      popover.open(level, {
        key: editorKey(id),
        title: t("filter_panel.condition"),
        heading: () => (
          <ConditionScope draft={draft}>
            <ConditionHeading id={id} />
          </ConditionScope>
        ),
        anchorTop,
        render: () => (
          <ConditionScope draft={draft}>
            <ConditionEditor id={id} />
          </ConditionScope>
        ),
        ...(draft.store.get().rows.length > 1 && {
          onDelete: { label: t("style_editor.remove_condition"), onClick: () => draft.actions.remove(id) },
        }),
      }),
    [popover, level, t, draft]
  );

  return (
    <>
      <RuleHeading action={many && <MatchMenu match={model.match} onChange={draft.actions.setMatch} />}>
        {t("style_editor.when")}
      </RuleHeading>
      {rows.map((row) => {
        const issues = rowIssues(row, fieldTypes);
        return (
          <ConditionRow
            key={row.id}
            row={row}
            label={labels.get(row.field) ?? row.field}
            type={typeOfRow(row, fieldTypes)}
            issues={issues.length ? issues : NONE}
            canEdit
            onOpen={openEditor}
            onRemove={many ? draft.actions.remove : undefined}
          />
        );
      })}
      <Box sx={{ px: 3, pt: 1 }}>
        {/* Under the last condition, its plus on the content's edge, as the filter panel's. */}
        <AddButton
          onClick={(event) => setAddAnchor(addAnchor ? null : event.currentTarget)}
          sx={{ ml: -2.5 }}>
          {t("style_editor.add_condition")}
        </AddButton>
        <FieldPicker
          anchorEl={addAnchor}
          onClose={() => setAddAnchor(null)}
          fields={fields}
          onChange={(field) => {
            const anchorTop = addAnchor ? anchorTopOf(addAnchor) : 0;
            const id = draft.newId();
            draft.actions.add({ id, field, op: operatorsFor(fieldTypes[field])[0], enabled: true });
            openEditor(id, anchorTop);
          }}
        />
      </Box>
    </>
  );
}
