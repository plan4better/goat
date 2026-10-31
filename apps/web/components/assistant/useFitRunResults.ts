"use client";

import { useMediaQuery, useTheme } from "@mui/material";
import bbox from "@turf/bbox";
import type { DynamicToolUIPart } from "ai";
import { useEffect, useRef } from "react";

import { useProjectLayers } from "@/lib/api/projects";
import { boxesOverlap, sameView } from "@/lib/assistant/mapView";
import { useActiveSurface, useDockState } from "@/lib/assistant/store";
import type { AssistantMessage, WorkflowRunData } from "@/lib/assistant/types";
import { wktToGeoJSON } from "@/lib/utils/map/wkt";

/** The tools whose result reports a workflow run with the layers it saved. */
const RUN_TOOLS: ReadonlySet<string> = new Set(["workflow_run", "workflow_last_run"]);

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;

/** A run the answers report, by its job. */
interface Run {
  projectId: string;
  /** A part of the conversation says it started the run (a later answer may only wait for it). */
  started: boolean;
  /** What the map showed while the run went, [west, south, east, north]; null before the map showed. */
  view: number[] | null;
  /** The layers the run saved, once it ended. */
  saved: number[] | null;
  /** Fitted, or no longer to be. */
  done: boolean;
}

const runParts = (messages: AssistantMessage[]): Array<WorkflowRunData & { job_id: string }> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part) =>
          part.type === "data-workflow-run" && part.data.job_id
            ? [{ ...part.data, job_id: part.data.job_id }]
            : []
        )
  );

/** The ended runs the answers report (`RunSummary`), with the layers each saved. */
const runResults = (messages: AssistantMessage[]): Array<{ jobId: string; saved: number[] }> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts
          .filter((part): part is DynamicToolUIPart => part.type === "dynamic-tool")
          .flatMap((part) => {
            if (part.state !== "output-available" || !RUN_TOOLS.has(part.toolName)) return [];
            const output = isRow(part.output) ? part.output : {};
            const saved = (Array.isArray(output.saved) ? output.saved : []).flatMap((layer) =>
              isRow(layer) && typeof layer.layer_project_id === "number" ? [layer.layer_project_id] : []
            );
            return typeof output.job_id === "string" && output.status !== "running" && saved.length > 0
              ? [{ jobId: output.job_id, saved }]
              : [];
          })
  );

/** A layer's extent as [west, south, east, north]; null when it cannot be read. */
function extentBox(extent: string): number[] | null {
  try {
    const box = bbox(wktToGeoJSON(extent));
    return box.every(Number.isFinite) ? box : null;
  } catch {
    return null;
  }
}

/**
 * Shows the result of a workflow run the conversation started: once the run
 * ended and its saved layers are in the open project, a map that shows none
 * of them is fitted to the first, once per run, without selecting it. Only in
 * Map mode of the conversation's project with the map beside the dock, and
 * only when the map still shows what it showed while the run went: a move
 * since, the user's or one a map control made, leaves it there.
 *
 * A run that ends while the map is not shown (another mode, the dock expanded
 * or on a phone) is not fitted later, also not once the dock collapses; a
 * remounted chat counts it among the runs of the conversation as it mounted
 * with it, which are left alone.
 */
export function useFitRunResults(
  messages: AssistantMessage[],
  initialMessages: AssistantMessage[],
  projectId: string | null
): void {
  const theme = useTheme();
  // The dock covers the map on a phone and when expanded.
  const isPhone = useMediaQuery(theme.breakpoints.down("md"));
  const { expanded } = useDockState();
  const surface = useActiveSurface();
  const mapProject =
    surface?.surface === "project.map" && projectId && surface.project?.id === projectId ? projectId : null;
  // The page reads the list and useWorkflowRunRefresh reads it again after a run: only follow the cache.
  const { layers } = useProjectLayers(mapProject ?? undefined, { revalidateOnMount: false });
  const mapShown = !!mapProject && !isPhone && !expanded;
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) {
    seen.current = new Set([
      ...runParts(initialMessages).map((data) => data.job_id),
      ...runResults(initialMessages).map((result) => result.jobId),
    ]);
  }
  const runs = useRef(new Map<string, Run>());
  useEffect(() => {
    const known = seen.current;
    if (!known) return;
    /** What the map of `project` shows, when it is the open page. */
    const viewOf = (project: string): number[] | null => {
      if (project !== mapProject) return null;
      const context = surface?.getContext();
      return (context?.surface === "project.map" && context.viewport?.bbox) || null;
    };
    for (const data of runParts(messages)) {
      if (known.has(data.job_id)) continue;
      const run = runs.current.get(data.job_id) ?? {
        projectId: data.project_id,
        started: false,
        view: viewOf(data.project_id),
        saved: null,
        done: false,
      };
      run.started ||= data.started;
      runs.current.set(data.job_id, run);
    }
    for (const { jobId, saved } of runResults(messages)) {
      const run = runs.current.get(jobId);
      if (run && !run.saved) run.saved = saved;
    }
    for (const run of runs.current.values()) {
      if (run.done || !run.started) continue;
      if (!run.saved) {
        // Started in another mode: the view from the moment the map shows.
        run.view ??= viewOf(run.projectId);
        continue;
      }
      if (!mapShown || run.projectId !== mapProject) {
        run.done = true;
        continue;
      }
      // The layer list is read again after the run (useWorkflowRunRefresh): wait for it.
      const found = run.saved.flatMap((id) => layers?.find((layer) => layer.id === id) ?? []);
      if (found.length < run.saved.length) continue;
      run.done = true;
      const view = viewOf(run.projectId);
      if (!view || !run.view || !sameView(run.view, view)) continue;
      const shapes = found.filter((layer) => layer.type !== "table");
      const boxes = shapes.map((layer) => extentBox(layer.extent));
      // An extent that cannot be read may be in view.
      if (!shapes.length || boxes.some((box) => !box || boxesOverlap(box, view))) continue;
      void surface?.zoomToLayer?.(shapes[0].id, { select: false });
    }
  }, [messages, layers, surface, mapShown, mapProject]);
}
