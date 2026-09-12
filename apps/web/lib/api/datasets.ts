import { BUNDLES_API_BASE_URL } from "@/lib/api/bundles";
import { apiRequestAuth } from "@/lib/api/fetcher";
import { LAYERS_API_BASE_URL } from "@/lib/api/layers";
import type { DatasetImportRequest, PresignedUploadResponse } from "@/lib/validations/datasets";
import { datasetImportRequestSchema, presignedUploadResponseSchema } from "@/lib/validations/datasets";

export const DATASETS_API_BASE_URL = new URL("api/v2/datasets", process.env.NEXT_PUBLIC_API_URL).href;

/**
 * SWR filter matching every key that renders content listings: the datasets
 * API, layer listings and bundle listings, whether the key is a bare URL, a
 * querystringed URL or an array key. Content mutations (create, rename, move,
 * delete — layer or bundle) revalidate with this so no mounted listing is
 * left showing a ghost.
 */
export const matchesContentListKey = (key: unknown): boolean => {
  const first = Array.isArray(key) ? key[0] : key;
  return (
    typeof first === "string" &&
    (first.startsWith(DATASETS_API_BASE_URL) ||
      first.startsWith(LAYERS_API_BASE_URL) ||
      first.startsWith(BUNDLES_API_BASE_URL))
  );
};

export const requestDatasetUpload = async (req: DatasetImportRequest): Promise<PresignedUploadResponse> => {
  // validate client input with zod first
  const validatedReq = datasetImportRequestSchema.parse(req);

  const response = await apiRequestAuth(`${DATASETS_API_BASE_URL}/request-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validatedReq),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request upload failed: ${errorText}`);
  }

  const data = await response.json();
  return presignedUploadResponseSchema.parse(data);
};
