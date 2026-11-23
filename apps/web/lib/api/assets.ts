import useSWR from "swr";

import { apiRequestAuth, fetcher } from "@/lib/api/fetcher";
import type { AssetTypeEnum, UploadedAsset } from "@/lib/validations/assets";
import { uploadedAssetSchema } from "@/lib/validations/assets";

export const ASSETS_API_BASE_URL = new URL("api/v2/asset", process.env.NEXT_PUBLIC_API_URL).href;

export const useAssets = (queryParams?: { asset_type?: AssetTypeEnum }) => {
  const { data, isLoading, error, mutate, isValidating } = useSWR<UploadedAsset[]>(
    [`${ASSETS_API_BASE_URL}`, queryParams],
    fetcher
  );
  return { assets: data, isLoading, isError: error, mutate, isValidating };
};

export const useDocuments = (folderId: string | undefined) => {
  const { data, isLoading, error, mutate } = useSWR<UploadedAsset[]>(
    folderId ? [`${ASSETS_API_BASE_URL}`, { asset_type: "document", folder_id: folderId }] : null,
    fetcher
  );
  return { documents: data ?? [], isLoading, isError: error, mutate };
};

/** An upload core refused: its status and its reason (the response's `detail`, else its text). */
export class AssetUploadError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`Upload failed: ${detail}`);
  }
}

export const uploadAsset = async (
  file: File,
  assetType: AssetTypeEnum,
  options?: {
    displayName?: string;
    category?: string;
    folderId?: string;
  }
): Promise<UploadedAsset> => {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("asset_type", assetType);

  if (options?.displayName) formData.append("display_name", options.displayName);
  if (options?.category) formData.append("category", options.category);
  if (options?.folderId) formData.append("folder_id", options.folderId);

  const response = await apiRequestAuth(`${ASSETS_API_BASE_URL}/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    let detail = errorText;
    try {
      const body = JSON.parse(errorText);
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // Not JSON: the text is the reason.
    }
    throw new AssetUploadError(response.status, detail);
  }

  const data = await response.json();
  return uploadedAssetSchema.parse(data);
};

export const updateAsset = async (
  assetId: string,
  updates: { display_name?: string; category?: string }
): Promise<UploadedAsset> => {
  const response = await apiRequestAuth(`${ASSETS_API_BASE_URL}/${assetId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Update failed: ${errorText}`);
  }

  const data = await response.json();
  return uploadedAssetSchema.parse(data);
};

export const deleteAsset = async (assetId: string): Promise<void> => {
  const response = await apiRequestAuth(`${ASSETS_API_BASE_URL}/${assetId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Delete failed: ${errorText}`);
  }
};
