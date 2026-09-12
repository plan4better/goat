import useSWR from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";

export const BUNDLES_API_BASE_URL = new URL("api/v2/bundle", process.env.NEXT_PUBLIC_API_URL).href;

export interface BundleImportRequest {
  s3_key: string;
  folder_id: string;
  name: string;
  description?: string;
  /** Street network bundle to link as a dependency (PT networks). */
  street_network_bundle_id?: string;
  /** If uploading from within a project, add the bundle to it once imported. */
  project_id?: string;
}

export interface BundleRead {
  id: string;
  name: string;
  folder_id: string;
  bundle_type: string;
  status: string;
  /** The bundle's derived artifacts and their build state. */
  artifacts?: BundleArtifact[];
  /** Whether the artifacts are built from the member layers. Gates filtering
   *  and rebuilding, both of which have to produce artifacts from layers —
   *  false for GTFS, whose feed is not kept. Resolved from the bundle type's
   *  spec server-side, so it flips on its own when a type gains support. */
  artifacts_from_layers?: boolean;
  description?: string | null;
  thumbnail_url?: string;
  created_at?: string;
  updated_at?: string;
  owned_by?: { id: string; firstname: string; lastname: string; avatar?: string | null } | null;
  /** Dataset-level provenance, as one document. Importers fill what the source
   *  states; licence, attribution and lineage are authored by the owner. */
  dataset_metadata?: BundleDatasetMetadata | null;
}

export interface BundleDatasetMetadata {
  lineage?: string | null;
  geographical_code?: string | null;
  distributor_name?: string | null;
  distributor_email?: string | null;
  distribution_url?: string | null;
  license?: string | null;
  attribution?: string | null;
  data_reference_year?: number | null;
}

export interface BundleArtifact {
  kind: string;
  /** Where it stands: ready, building, outdated or failed. Derived server-side
   *  from the build outcome and the revisions, so the rule lives in one place. */
  state: "ready" | "building" | "outdated" | "failed";
  /** What the last build attempt did — the raw fact `state` is derived from. */
  build_status: "building" | "complete" | "failed";
  /** The bundle revision this artifact was built from; null if never built. */
  revision?: number | null;
  size?: number | null;
  /** What the build recorded about its own output — a PT timetable's
   *  `service_start` / `service_days`, which bound a date offered against it.
   *  Free-form by design, so read defensively. */
  properties?: Record<string, unknown> | null;
  updated_at?: string | null;
}

export interface BundleMember {
  layer_id: string;
  role: string | null;
  name?: string | null;
  type?: string | null;
  feature_layer_geometry_type?: string | null;
  /** Resolved from the bundle type's spec: may this member's features be edited. */
  editable?: boolean;
}

export interface BundleForLayer {
  bundle_id: string;
  bundle_type: string;
  role: string | null;
  editable: boolean;
  /** Sent back as base_revision on save, so a concurrent change is refused. */
  layers_revision: number;
}

export interface BundleDependency {
  dependency_kind: string;
  depends_on_bundle_id: string;
  depends_on_name: string;
  depends_on_type: string;
}

export interface BundleImportResponse {
  bundle: BundleRead;
  /** Windmill job id for the background ingest; poll for status. */
  job_id: string | null;
}

/**
 * A bundle type the upload flow can recognise from a file. Adding a new
 * type (OSM, PBF, …) is a new entry here — the upload UI stays generic. The
 * backend independently re-infers and validates the type from the file, so this
 * is only for routing the upload and showing the detected type.
 */
export interface BundleTypeDef {
  /** Type id, matching the backend's BundleTypeName. */
  type: string;
  /** i18n key for the type's display name (e.g. "pt_network_gtfs"). */
  labelKey: string;
  /** Short format label for the "supported formats" hint. */
  uploadHint: string;
  /** Whether an uploaded file is this bundle type. */
  matches: (file: File) => boolean;
  /** Whether the upload must name a street network bundle to link. Follows the
   *  type's own required dependency: a GTFS feed's stop-to-street linkage is
   *  computed against a street network. */
  requiresStreetNetwork?: boolean;
  /** i18n key for what the upload screen explains about this type: what the
   *  one file becomes, and why it asks for what it asks for. Per type, since
   *  no two of them import the same way. */
  uploadNoteKey?: string;
}

export const BUNDLE_TYPES: BundleTypeDef[] = [
  {
    type: "pt_network_gtfs",
    labelKey: "pt_network_gtfs",
    uploadHint: "GTFS (gtfs.zip)",
    matches: (file) => {
      const name = file.name.toLowerCase();
      return name.endsWith(".zip") && name.includes("gtfs");
    },
    requiresStreetNetwork: true,
    uploadNoteKey: "bundle_upload_note_pt_network_gtfs",
  },
  {
    type: "street_network",
    labelKey: "street_network",
    uploadHint: "Overture (overture.zip)",
    // Name-based only. The backend additionally sniffs the archive for
    // segments/connectors GeoParquet, so a differently-named zip is still
    // accepted through the API — but the UI can't see inside the file, so from
    // here the name has to say "overture".
    matches: (file) => {
      const name = file.name.toLowerCase();
      return name.endsWith(".zip") && name.includes("overture");
    },
  },
];

/**
 * Detect which bundle type an uploaded file is, or null when it's a
 * plain single-layer dataset.
 */
export const detectBundleType = (file: File | null | undefined): BundleTypeDef | null =>
  file ? (BUNDLE_TYPES.find((t) => t.matches(file)) ?? null) : null;

/**
 * True when a content tile is a bundle rather than a layer. The layer
 * listing endpoint tags bundle items with `content_type: "bundle"`.
 */
export const isBundleTile = (item: unknown): boolean =>
  !!item && typeof item === "object" && (item as { content_type?: string }).content_type === "bundle";

export const requestBundleImport = async (req: BundleImportRequest): Promise<BundleImportResponse> => {
  const response = await apiRequestAuth(`${BUNDLES_API_BASE_URL}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bundle import failed: ${errorText}`);
  }

  return (await response.json()) as BundleImportResponse;
};

/** Delete a bundle and all its member layers (owner only). */
export const deleteBundle = async (bundleId: string): Promise<void> => {
  const response = await apiRequestAuth(`${BUNDLES_API_BASE_URL}/${bundleId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bundle delete failed: ${errorText}`);
  }
};

/** Update a bundle (e.g. move to another folder). Owner only. */
export const updateBundle = async (
  bundleId: string,
  payload: Partial<Omit<BundleRead, "id" | "bundle_type" | "status" | "owned_by">>
): Promise<BundleRead> => {
  const response = await apiRequestAuth(`${BUNDLES_API_BASE_URL}/${bundleId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bundle update failed: ${errorText}`);
  }
  return (await response.json()) as BundleRead;
};

// --- Sharing (grant-based, same model as folders) --------------------------

export type BundleGranteeType = "team" | "organization";
export type BundleRole = "bundle-viewer" | "bundle-editor";

export interface BundleGrant {
  grantee_type: BundleGranteeType;
  grantee_id: string;
  grantee_name: string;
  role: BundleRole;
}

export interface BundleGrantsResponse {
  grants: BundleGrant[];
}

/** List bundles the user can access. Optionally restrict by `bundleType` and/or
 *  to bundles with a ready artifact of `artifactKind` (e.g. "pt_network_gtfs" +
 *  "pt_network_graph" for routable PT bundles). */
export const useBundles = (opts?: {
  bundleType?: string;
  artifactKind?: string;
  /** Skip the request entirely — for a selector that only some files need. */
  enabled?: boolean;
}) => {
  const params = new URLSearchParams();
  if (opts?.bundleType) params.set("bundle_type", opts.bundleType);
  if (opts?.artifactKind) params.set("artifact_kind", opts.artifactKind);
  const qs = params.toString();
  return useSWR<BundleRead[]>(
    opts?.enabled === false ? null : `${BUNDLES_API_BASE_URL}${qs ? `?${qs}` : ""}`,
    fetcher
  );
};

/** Fetch a single bundle for its detail page. */
export const useBundle = (bundleId: string | null) => {
  const { data, isLoading, error, mutate } = useSWR<BundleRead>(
    bundleId ? `${BUNDLES_API_BASE_URL}/${bundleId}` : null,
    fetcher
  );
  return { bundle: data, isLoading, isError: !!error, mutate };
};

/** Member layers of a bundle, each with its spec role. */
export const useBundleLayers = (bundleId: string | null) => {
  const { data, isLoading, error } = useSWR<BundleMember[]>(
    bundleId ? `${BUNDLES_API_BASE_URL}/${bundleId}/layers` : null,
    fetcher
  );
  return { members: data, isLoading, isError: !!error };
};

/** The bundle a layer belongs to, or undefined for an ordinary layer.
 *
 *  A plain layer is the common case, so a 404 is an answer rather than an
 *  error — it means "not a member".
 *
 *  `isMembershipUnresolved` separates the two things an absent bundle can
 *  mean. A 404 answers the question; a failed request leaves it unanswered,
 *  and a caller that treats the second as "ordinary layer" sends a member's
 *  edits to an endpoint that refuses them. */
export const useBundleForLayer = (layerId: string | null) => {
  const { data, isLoading, error, mutate } = useSWR<BundleForLayer | null>(
    layerId ? `${BUNDLES_API_BASE_URL}/by-layer/${layerId}` : null,
    async (url: string) => {
      const response = await apiRequestAuth(url);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Failed to resolve the layer's bundle");
      return response.json();
    }
  );
  return {
    bundleForLayer: data ?? undefined,
    isLoading,
    isMembershipUnresolved: !!layerId && !!error,
    mutate,
  };
};

/** Other bundles this bundle depends on (e.g. a GTFS feed's street network). */
export const useBundleDependencies = (bundleId: string | null) => {
  const { data, isLoading, error } = useSWR<BundleDependency[]>(
    bundleId ? `${BUNDLES_API_BASE_URL}/${bundleId}/dependencies` : null,
    fetcher
  );
  return { dependencies: data, isLoading, isError: !!error };
};

/** Fetch the grants (team/org access) on a bundle. Owner only. */
export const useBundleGrants = (bundleId: string | null) =>
  useSWR<BundleGrantsResponse>(bundleId ? `${BUNDLES_API_BASE_URL}/${bundleId}/share` : null, fetcher);

/** Grant (or update) a team/org's access to a bundle. */
export const shareBundleGrant = async (
  bundleId: string,
  payload: {
    grantee_type: BundleGranteeType;
    grantee_id: string;
    role: BundleRole;
  }
): Promise<BundleGrantsResponse> => {
  const response = await apiRequestAuth(`${BUNDLES_API_BASE_URL}/${bundleId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to share bundle");
  }
  return response.json();
};

/** Revoke a team/org's access to a bundle. */
export const deleteBundleGrant = async (
  bundleId: string,
  granteeType: string,
  granteeId: string
): Promise<void> => {
  const response = await apiRequestAuth(
    `${BUNDLES_API_BASE_URL}/${bundleId}/share/${granteeType}/${granteeId}`,
    { method: "DELETE" }
  );
  if (!response.ok && response.status !== 204) {
    throw new Error("Failed to remove bundle access");
  }
};
