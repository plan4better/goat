"use client";

// A project layer's filter for the filter panel: the saved `query.cql` with its notes `query.ui` read as rows, the
// layer's fields, what the panel says about the rows, whether the user may change it, and the save. Reading never
// writes; a save happens only when what the rows write differs from what is saved.
import { useCallback, useMemo, useRef } from "react";

import { useLayerQueryables } from "@/lib/api/layers";
import { updateProjectLayer, useProject, useProjectLayers } from "@/lib/api/projects";
import { type FilterIssues, NO_ISSUES, filterIssues } from "@/lib/filter/issues";
import type { Fields, FilterModel } from "@/lib/filter/model";
import { readFilter } from "@/lib/filter/read";
import { writeFilter } from "@/lib/filter/write";
import type { ProjectLayer } from "@/lib/validations/project";

import { fieldsOf } from "@/hooks/style/useStyleData";

import type { FieldInfo } from "@/components/map/panels/styleEditor/context";

/** A save the server refused, with its messages. */
export class FilterSaveError extends Error {
  constructor(public readonly messages: string[]) {
    super(messages.join("\n"));
    this.name = "FilterSaveError";
  }
}

/** The server's messages of a failed save: core's `detail` as text, or a validation error's list of `msg`. */
function messagesOf(error: unknown): string[] {
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail) return [detail];
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (typeof item === "string" ? item : (item as { msg?: unknown })?.msg))
      .filter((msg): msg is string => typeof msg === "string" && !!msg)
      // Pydantic's prefix says nothing to a person.
      .map((msg) => msg.replace(/^Value error, /, ""));
    if (messages.length) return messages;
  }
  return [error instanceof Error ? error.message : String(error)];
}

const json = (value: unknown) => JSON.stringify(value ?? null);

type FilteredLayer = Pick<ProjectLayer, "id" | "layer_id" | "query">;

export interface LayerFilter {
  model: FilterModel;
  fields: Fields;
  /** The fields with their display names, for the field pickers. */
  fieldInfos: FieldInfo[];
  issues: FilterIssues;
  canEdit: boolean;
  /** The fields are still loading: the rows read without them would guess types. */
  isLoading: boolean;
  apply: (model: FilterModel) => Promise<void>;
}

export function useLayerFilter(projectId: string, projectLayer: FilteredLayer): LayerFilter {
  const { queryables, isLoading } = useLayerQueryables(projectLayer.layer_id);
  const fieldInfos = useMemo(
    () => fieldsOf(queryables?.properties as Parameters<typeof fieldsOf>[0]),
    [queryables]
  );
  const fields = useMemo<Fields>(
    () => Object.fromEntries(fieldInfos.map((f) => [f.name, f.type])),
    [fieldInfos]
  );
  // Who may change the filter: a project editor, as the layer settings decide for the style.
  const { project } = useProject(projectId);
  const canEdit = !project?.my_role || ["project-owner", "project-editor"].includes(project.my_role);
  const { mutate } = useProjectLayers(projectId);

  const cql = projectLayer.query?.cql;
  const ui = projectLayer.query?.ui;
  const model = useMemo(() => readFilter(cql, ui, fields), [cql, ui, fields]);
  const loaded = !!queryables;
  const issues = useMemo(() => (loaded ? filterIssues(model, fields) : NO_ISSUES), [loaded, model, fields]);

  // The saved values as of now, so an apply compares with the latest even from a callback made before it.
  const saved = useRef({ cql, ui, metadata: projectLayer.query?.metadata });
  saved.current = { cql, ui, metadata: projectLayer.query?.metadata };
  const layerId = projectLayer.id;

  const apply = useCallback(
    async (next: FilterModel) => {
      const written = writeFilter(next, fields);
      if (json(written.cql) === json(saved.current.cql) && json(written.ui) === json(saved.current.ui))
        return;
      // Core writes `query` whole: the notes go with every save (none removes stale ones) and a stored `metadata`
      // is sent back as it was. No filter and nothing else is `null`, as the panel always cleared a filter.
      const metadata = saved.current.metadata;
      const parts = {
        ...(metadata ? { metadata } : {}),
        ...(written.cql ? { cql: written.cql } : {}),
        ...(written.ui ? { ui: written.ui } : {}),
      };
      const query = Object.keys(parts).length ? parts : null;
      try {
        // Shown at once; the list goes back to what it was when the server refuses.
        await mutate(
          async () => {
            await updateProjectLayer(projectId, layerId, { query } as Parameters<
              typeof updateProjectLayer
            >[2]);
            return undefined;
          },
          {
            optimisticData: (current?: ProjectLayer[]) =>
              (current ?? []).map((layer) =>
                layer.id === layerId ? { ...layer, query } : layer
              ) as ProjectLayer[],
            rollbackOnError: true,
            populateCache: false,
            revalidate: false,
          }
        );
      } catch (error) {
        throw new FilterSaveError(messagesOf(error));
      }
    },
    [fields, mutate, projectId, layerId]
  );

  return { model, fields, fieldInfos, issues, canEdit, isLoading: isLoading && !loaded, apply };
}
