"use client";

// The filter panel (conditions): one row per condition, matched all or any, each opening its editor beside the panel
// as the style panel's rows do. It edits a draft of the rows and hands the model up only when what it saves changes:
// a row once complete, cleared, switched or removed. An unfinished row stays in the draft, marked, and saves nothing.
// Above the conditions is the filter's area (the area folder): one for the whole filter, which the conditions'
// "all or any" does not reach. It knows nothing of where the filter is kept: the caller gives the saved model and
// saves what it hands up.
import { Alert, Box, Typography } from "@mui/material";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

import { areaPolygons, pointCount } from "@/lib/filter/area";
import { FILTER_LIMITS } from "@/lib/filter/generated/operators";
import { type FilterIssue, type FilterIssues, rowIssues } from "@/lib/filter/issues";
import { urlLength } from "@/lib/filter/limits";
import { type Fields, type FilterModel, type FilterRow, isCustomRow } from "@/lib/filter/model";
import { operatorsFor } from "@/lib/filter/rows";
import { writeFilter } from "@/lib/filter/write";

import {
  ConditionEditor,
  ConditionHeading,
  ConditionRow,
  issueText,
} from "@/components/map/panels/filter/ConditionRow";
import { CustomRow } from "@/components/map/panels/filter/CustomRow";
import { MatchMenu } from "@/components/map/panels/filter/MatchMenu";
import { ResultHeader } from "@/components/map/panels/filter/ResultHeader";
import { editorKey } from "@/components/map/panels/filter/RowShell";
import { AreaSection, SavedArea } from "@/components/map/panels/filter/area/AreaSection";
import {
  type AreaLayer,
  AreaToolsProvider,
  useAreaTools,
} from "@/components/map/panels/filter/area/AreaTools";
import {
  type AreaHost,
  type AreaLimits,
  type AreaWay,
  MAIN_MAP,
} from "@/components/map/panels/filter/area/host";
import { useAreaOutline } from "@/components/map/panels/filter/area/outline";
import {
  type DraftAction,
  type DraftActions,
  DraftStore,
  FilterPanelContext,
  type FilterPanelContextValue,
  isUnfinished,
  reduceDraft,
  typeOfRow,
  writtenText,
} from "@/components/map/panels/filter/draft";
import type { FieldInfo } from "@/components/map/panels/styleEditor/context";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";
import { PopoverProvider } from "@/components/map/panels/styleEditor/popovers/PopoverStack";
import {
  anchorTopOf,
  useNextLevel,
  usePopover,
} from "@/components/map/panels/styleEditor/popovers/usePopover";
import { AddButton, PanelSection } from "@/components/map/panels/styleEditor/rows";

const NONE: readonly FilterIssue[] = [];

export interface FilterPanelProps {
  /** The saved filter as rows. */
  model: FilterModel;
  fields: Fields;
  /** The saved rows' issues by row id, and the filter's. */
  issues: FilterIssues;
  canEdit: boolean;
  /** Whether a row can be switched off. False where the saved format keeps no switched-off rows. */
  canSwitch?: boolean;
  /** Saves the rows; a rejection with `messages` (the server's refusal) shows at the top. */
  onApply: (model: FilterModel) => Promise<void> | void;
  /** The fields with their display names; the names alone without it. */
  fieldInfos?: FieldInfo[];
  /** The dataset whose values the value lists offer; without it values are typed. */
  layerId?: string;
  /** Closes the open editors when it changes (another layer). */
  scope?: unknown;
  /** Whether an area can be set (it is drawn on and read from the map). Without it a saved area shows as a line
   * that can only be removed. */
  area?: boolean;
  /** The polygon layers whose features the area can be picked from. */
  areaLayers?: readonly AreaLayer[];
  /** The caller's action on what the filter keeps, under the result's count and bar. It opens its popovers in the
   * panel's stack, so they take the place of a condition's editor rather than covering it. */
  resultAction?: ReactNode;
  /** Whether the panel is on screen (its tab is the open one): its area is drawn on the map only then. */
  shown?: boolean;
}

const FILTER_WAYS: readonly AreaWay[] = ["view", "polygon", "circle", "regions", "features"];

/** The draft's area as the area picker works on it, within what one filter may hold. */
function useFilterAreaHost(store: DraftStore, actions: DraftActions, fields: Fields): AreaHost {
  const read = useCallback(() => store.get().area, [store]);
  const area = useSyncExternalStore(store.subscribe, read, read);
  const limits = useMemo<AreaLimits>(
    () => ({
      shapes: FILTER_LIMITS.shapes,
      features: FILTER_LIMITS.features,
      // The points limit, and the length a map request takes. Measured switched on: a switched-off area has to fit
      // once it is switched on again.
      fits: (next) => {
        if (pointCount(areaPolygons(next)) > FILTER_LIMITS.points) return false;
        const model = { ...store.get(), area: { ...next, enabled: true } };
        return urlLength(writeFilter(model, fields).cql) <= FILTER_LIMITS.length;
      },
    }),
    [store, fields]
  );
  return useMemo(
    () => ({ area, read, setArea: actions.setArea, limits, ops: true, ways: FILTER_WAYS, map: MAIN_MAP }),
    [area, read, actions, limits]
  );
}

/** Draws the area on the map while the panel is on screen. Off screen, a shape being drawn or edited is given up: the
 * panel stays mounted, hidden. */
function AreaOutline({ shown }: { shown: boolean }) {
  const { outline, cancelDraw } = useAreaTools();
  useAreaOutline(shown ? outline : undefined);
  useEffect(() => {
    if (!shown) cancelDraw();
  }, [shown, cancelDraw]);
  return null;
}

/** A failed save's messages: the server's, else the error's own. */
const messagesOf = (error: unknown): string[] => {
  const messages = (error as { messages?: unknown } | null)?.messages;
  if (Array.isArray(messages) && messages.length) return messages.map(String);
  return [error instanceof Error ? error.message : String(error)];
};

export function FilterPanel({
  model,
  fields,
  issues,
  canEdit,
  canSwitch = true,
  onApply,
  fieldInfos,
  layerId,
  scope,
  area = true,
  areaLayers,
  shown = true,
  resultAction,
}: FilterPanelProps) {
  const [store] = useState(() => new DraftStore(model));
  const [refusal, setRefusal] = useState<string[] | null>(null);
  const latest = useRef({ onApply, fields, canEdit });
  latest.current = { onApply, fields, canEdit };

  // A change of the saved filter from outside (another panel, the assistant, a refused save rolled back) replaces
  // the draft, keeping the rows still being written. The panel's own save comes back as what the draft writes and
  // changes nothing, so open editors keep their rows.
  useEffect(() => {
    const draft = store.get();
    if (draft === model) return;
    const now = new Date();
    if (writtenText(model, fields, now) === writtenText(draft, fields, now)) return;
    const kept = draft.rows.filter(
      (row) => !isCustomRow(row) && isUnfinished(row, fields) && !model.rows.some((r) => r.id === row.id)
    );
    store.set(kept.length ? { ...model, rows: [...model.rows, ...kept] } : model);
  }, [store, model, fields]);

  const actions = useMemo<DraftActions>(() => {
    const dispatch = (action: DraftAction) => {
      const { onApply: apply, fields: known, canEdit: may } = latest.current;
      if (!may) return;
      const prev = store.get();
      const next = reduceDraft(prev, action);
      if (next === prev) return;
      store.set(next);
      // Only what the filter saves calls up: an unfinished row changes nothing there.
      const now = new Date();
      if (writtenText(prev, known, now) === writtenText(next, known, now)) return;
      Promise.resolve()
        .then(() => apply(next))
        .then(
          () => setRefusal(null),
          (error: unknown) => setRefusal(messagesOf(error))
        );
    };
    return {
      update: (id, patch) => dispatch({ type: "update", id, patch }),
      remove: (id) => dispatch({ type: "remove", id }),
      toggle: (id) => dispatch({ type: "toggle", id }),
      setMatch: (match) => dispatch({ type: "match", match }),
      add: (row) => dispatch({ type: "add", row }),
      clear: () => dispatch({ type: "clear" }),
      setArea: (area) => dispatch({ type: "area", area }),
    };
  }, [store]);

  const infos = useMemo(
    () => fieldInfos ?? Object.entries(fields).map(([name, type]) => ({ name, type, label: name })),
    [fieldInfos, fields]
  );
  const context = useMemo<FilterPanelContextValue>(
    () => ({ store, actions, fields, fieldInfos: infos, layerId }),
    [store, actions, fields, infos, layerId]
  );
  const host = useFilterAreaHost(store, actions, fields);

  const body = (
    <PopoverProvider scope={scope}>
      <FilterBody
        model={model}
        issues={issues}
        canEdit={canEdit}
        canSwitch={canSwitch}
        area={area}
        refusal={refusal}
        fields={fields}
        infos={infos}
        layerId={layerId}
        store={store}
        actions={actions}
        resultAction={resultAction}
      />
    </PopoverProvider>
  );
  return (
    <FilterPanelContext.Provider value={context}>
      {/* The popovers open beside this box, as the style panel's beside its own. */}
      <Box
        data-style-panel
        data-testid="filter-panel"
        sx={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}>
        {/* The area's tools stay above the popovers: a shape is drawn on the map with them closed. */}
        {area ? (
          <AreaToolsProvider host={host} layers={areaLayers}>
            <AreaOutline shown={shown} />
            {body}
          </AreaToolsProvider>
        ) : (
          body
        )}
      </Box>
    </FilterPanelContext.Provider>
  );
}

function FilterBody({
  model,
  issues,
  canEdit,
  canSwitch,
  area,
  refusal,
  fields,
  infos,
  layerId,
  store,
  actions,
  resultAction,
}: {
  model: FilterModel;
  issues: FilterIssues;
  canEdit: boolean;
  canSwitch: boolean;
  area: boolean;
  refusal: string[] | null;
  fields: Fields;
  infos: FieldInfo[];
  layerId: string | undefined;
  store: DraftStore;
  actions: DraftActions;
  resultAction?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const popover = usePopover();
  const level = useNextLevel();
  const draft = useSyncExternalStore(store.subscribe, store.get, store.get);
  const labels = useMemo(() => new Map(infos.map((f) => [f.name, f.label])), [infos]);

  // A row as it was saved carries the issues the caller found; a row changed here is checked again, once per change.
  // The checks hold for the fields they were made with.
  const checked = useRef({ fields, rows: new WeakMap<FilterRow, readonly FilterIssue[]>() });
  if (checked.current.fields !== fields) checked.current = { fields, rows: new WeakMap() };
  const issuesOf = (row: FilterRow): readonly FilterIssue[] => {
    if (model.rows.find((saved) => saved.id === row.id) === row) return issues.rows[row.id] ?? NONE;
    let found = checked.current.rows.get(row);
    if (!found) {
      const list = rowIssues(row, fields);
      found = list.length ? list : NONE;
      checked.current.rows.set(row, found);
    }
    return found;
  };

  const openEditor = useCallback(
    (id: string, anchorTop: number) =>
      popover.open(level, {
        key: editorKey(id),
        title: t("filter_panel.condition"),
        heading: () => <ConditionHeading id={id} />,
        anchorTop,
        render: () => <ConditionEditor id={id} />,
        onDelete: { label: t("style_editor.remove_condition"), onClick: () => actions.remove(id) },
      }),
    [popover, level, t, actions]
  );

  const counter = useRef(0);
  const newId = () => {
    const taken = new Set(store.get().rows.map((row) => row.id));
    let id: string;
    do id = `n${(counter.current += 1)}`;
    while (taken.has(id));
    return id;
  };
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const full = draft.rows.length >= FILTER_LIMITS.conditions;
  // A dataset with no fields (geometries alone) has nothing a condition could compare.
  const noFields = infos.length === 0;
  const limitText = t("filter_panel.limit_conditions", { limit: FILTER_LIMITS.conditions });
  const rows = draft.rows;
  // What the draft saves, as the count takes it. Kept per draft: a relative date is written against the clock.
  const filterText = useMemo(() => {
    const cql = writeFilter(draft, fields).cql;
    return cql ? JSON.stringify(cql) : undefined;
  }, [draft, fields]);
  const clear = useCallback(() => {
    popover.close(level);
    actions.clear();
  }, [popover, level, actions]);

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 4 }}>
      {refusal && (
        <Alert severity="error" sx={{ mx: 3, mt: 3 }}>
          <Typography variant="body2">{t("filter_panel.save_refused")}</Typography>
          {refusal.map((message, i) => (
            <Typography key={i} variant="caption" component="p">
              {message}
            </Typography>
          ))}
        </Alert>
      )}
      {issues.filter.map((issue) => (
        <Alert key={issue.code} severity="warning" sx={{ mx: 3, mt: 3 }}>
          <Typography variant="caption">{issueText(t, issue)}</Typography>
        </Alert>
      ))}
      <ResultHeader
        layerId={layerId}
        filter={filterText}
        onClear={canEdit && (rows.length > 0 || draft.area) ? clear : undefined}
        actions={resultAction}
      />
      {area ? <AreaSection canEdit={canEdit} canSwitch={canSwitch} /> : <SavedArea canEdit={canEdit} />}
      <PanelSection
        title={t("filter_panel.title")}
        scope={
          rows.length > 1 &&
          (canEdit ? (
            <MatchMenu match={draft.match} onChange={actions.setMatch} />
          ) : (
            <Typography variant="caption" fontWeight="bold" color="text.secondary">
              {t(`filter_panel.match_${draft.match}`)}
            </Typography>
          ))
        }>
        {rows.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 3, pb: 1 }}>
            {t(noFields ? "filter_panel.no_fields" : "filter_panel.empty")}
          </Typography>
        )}
        {rows.map((row) =>
          isCustomRow(row) ? (
            <CustomRow
              key={row.id}
              row={row}
              canEdit={canEdit}
              onToggle={canSwitch ? actions.toggle : undefined}
              onRemove={actions.remove}
            />
          ) : (
            <ConditionRow
              key={row.id}
              row={row}
              label={labels.get(row.field) ?? row.field}
              type={typeOfRow(row, fields)}
              issues={issuesOf(row)}
              canEdit={canEdit}
              onOpen={openEditor}
              onToggle={canSwitch ? actions.toggle : undefined}
              onRemove={actions.remove}
            />
          )
        )}
        {canEdit && !noFields && (
          <Box sx={{ px: 3, pt: 1 }}>
            {/* Under the last condition, its plus on the content's edge (as a rule's "Add a condition"). */}
            <AddButton
              disabled={full}
              onClick={(event) => setAddAnchor(addAnchor ? null : event.currentTarget)}
              sx={{ ml: -2.5 }}>
              {t("style_editor.add_condition")}
            </AddButton>
            {full && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                {limitText}
              </Typography>
            )}
            <FieldPicker
              anchorEl={addAnchor}
              onClose={() => setAddAnchor(null)}
              fields={infos}
              onChange={(field) => {
                const anchorTop = addAnchor ? anchorTopOf(addAnchor) : 0;
                const id = newId();
                actions.add({ id, field, op: operatorsFor(fields[field])[0], enabled: true });
                openEditor(id, anchorTop);
              }}
            />
          </Box>
        )}
      </PanelSection>
    </Box>
  );
}
