"use client";

import { useBundle, useBundleLayers } from "@/lib/api/bundles";
import { useDataset } from "@/lib/api/layers";
import { useFeatureCount } from "@/lib/api/processes";
import { useProject, useProjectLayers } from "@/lib/api/projects";
import { useReportLayouts } from "@/lib/api/reportLayouts";
import { useUserProfile } from "@/lib/api/users";
import { useWorkflows } from "@/lib/api/workflows";
import type { ResultItem } from "@/lib/assistant/items";

type Person = { id: string; firstname?: string | null; lastname?: string | null } | null | undefined;

/** Who an item belongs to, as the card names it. */
export type ItemOwner = { kind: "you" } | { kind: "person" | "team" | "organization"; name: string };

export interface ItemDetails {
  thumbnail?: string;
  /** A dataset's geometry ("point", "line", "polygon") or its type ("table", "raster"). */
  geometry?: string;
  owner?: ItemOwner;
  updatedAt?: string;
  /** A project's layers. */
  layerCount?: number;
  /** A dataset's features (a table's rows). */
  featureCount?: number;
  /** A bundle's members, and how many of them a map can draw. */
  members?: { total: number; drawable: number };
}

/**
 * What a card shows beyond the tool's result, read when the card is shown and
 * with the user's own session: the thumbnail (its link expires), the owner and
 * the last change. None of it goes to the model, and it is current in an old
 * conversation too. Each hook fetches only for its own kind.
 */
export function useItemDetails(item: ResultItem): ItemDetails {
  const { userProfile } = useUserProfile();
  const datasetId =
    item.kind === "dataset" ? (item.datasetId ?? item.id) : item.kind === "layer" ? item.datasetId : null;
  const { project } = useProject(item.kind === "project" ? item.id : undefined);
  const { layers } = useProjectLayers(item.kind === "project" ? item.id : undefined);
  const { dataset } = useDataset(datasetId ?? "");
  // Counted by the same process the layer list uses; a raster has no features.
  const { featureCount } = useFeatureCount(
    datasetId && dataset && dataset.type !== "raster" ? datasetId : undefined
  );
  const { bundle } = useBundle(item.kind === "bundle" ? item.id : null);
  const { members } = useBundleLayers(item.kind === "bundle" ? item.id : null);
  const { workflows } = useWorkflows(item.kind === "workflow" ? (item.projectId ?? undefined) : undefined);
  const { reportLayouts } = useReportLayouts(
    item.kind === "layout" ? (item.projectId ?? undefined) : undefined
  );

  const person = (owner: Person): ItemOwner | undefined => {
    if (!owner) return undefined;
    if (userProfile && owner.id === userProfile.id) return { kind: "you" };
    const name = [owner.firstname, owner.lastname].filter(Boolean).join(" ");
    return name ? { kind: "person", name } : undefined;
  };

  switch (item.kind) {
    case "project":
      return {
        thumbnail: project?.thumbnail_url ?? undefined,
        // A team's or the organization's project is theirs; a personal one its owner's.
        owner:
          project?.space_kind && project.space_kind !== "personal" && project.space_name
            ? { kind: project.space_kind, name: project.space_name }
            : person(project?.owned_by),
        updatedAt: project?.updated_at,
        layerCount: layers?.length,
      };
    case "dataset":
    case "layer":
      return {
        thumbnail: dataset?.thumbnail_url ?? undefined,
        geometry:
          dataset?.type === "feature"
            ? (dataset.feature_layer_geometry_type ?? undefined)
            : (dataset?.type ?? undefined),
        owner: person(dataset?.owned_by),
        updatedAt: dataset?.updated_at,
        featureCount,
      };
    case "bundle":
      return {
        thumbnail: bundle?.thumbnail_url ?? undefined,
        owner: person(bundle?.owned_by),
        updatedAt: bundle?.updated_at ?? undefined,
        members: members && {
          total: members.length,
          drawable: members.filter((member) => member.type === "feature" || member.type === "raster").length,
        },
      };
    case "workflow":
    case "layout": {
      const own =
        item.kind === "workflow"
          ? workflows?.find((workflow) => workflow.id === item.id)
          : reportLayouts?.find((layout) => layout.id === item.id);
      return { thumbnail: own?.thumbnail_url ?? undefined, updatedAt: own?.updated_at ?? undefined };
    }
    default:
      return {};
  }
}
