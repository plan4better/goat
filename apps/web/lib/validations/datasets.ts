import { z } from "zod";

// Request schema
export const datasetImportRequestSchema = z.object({
    filename: z.string().min(1),
    content_type: z.string().default("application/octet-stream"),
    file_size: z.number().positive(),
});

export type DatasetImportRequest = z.infer<typeof datasetImportRequestSchema>;

// Response schema (presigned PUT)
export const presignedUploadResponseSchema = z.object({
    url: z.string().url(),
    key: z.string(),
    headers: z.record(z.string()).default({}),
});

export type PresignedUploadResponse = z.infer<typeof presignedUploadResponseSchema>;