import type { PresignedUploadResponse } from "@/lib/validations/datasets";

/**
 * Send a file straight to object storage with the presigned PUT core issued.
 * The raw file is the request body; the signed headers must be sent unchanged.
 */
export async function uploadFileToS3(file: File, presigned: PresignedUploadResponse) {
    const res = await fetch(presigned.url, {
        method: "PUT",
        headers: presigned.headers,
        body: file,
    });

    if (!res.ok) {
        throw new Error(`S3 upload failed with status ${res.status}`);
    }
}
