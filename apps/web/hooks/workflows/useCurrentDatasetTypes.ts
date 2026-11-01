"use client";

import type { Node } from "@xyflow/react";
import { useParams } from "next/navigation";
import { useMemo } from "react";

import { useProjectLayers } from "@/lib/api/projects";
import { withCurrentDatasetTypes } from "@/lib/utils/workflowDatasets";

/**
 * The workflow's nodes with each dataset step's layer type and geometry
 * type read from the project's layer list (the list the layer picker and
 * the dataset nodes' names read), so the canvas checks connections against
 * the layer as it is now. The stored types stay the fallback while the list
 * loads and for a layer the project does not carry.
 */
export function useCurrentDatasetTypes<T extends Node>(nodes: T[]): T[] {
  const { projectId } = useParams() as { projectId?: string };
  const { layers } = useProjectLayers(projectId);
  return useMemo(() => withCurrentDatasetTypes(nodes, layers), [nodes, layers]);
}
