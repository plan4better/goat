import { apiRequestAuth } from "@/lib/api/fetcher";
import type { DatasetImportRequest, PresignedUploadResponse } from "@/lib/validations/datasets";
import { datasetImportRequestSchema, presignedUploadResponseSchema } from "@/lib/validations/datasets";


export const DATASET_IMPORTS_API_BASE_URL = new URL(
    "api/v2/datasets",
    process.env.NEXT_PUBLIC_API_URL
).href;

export const requestDatasetUpload = async (
    req: DatasetImportRequest
): Promise<PresignedUploadResponse> => {
    // validate client input with zod first
    const validatedReq = datasetImportRequestSchema.parse(req);

    const response = await apiRequestAuth(`${DATASET_IMPORTS_API_BASE_URL}/request-upload`, {
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