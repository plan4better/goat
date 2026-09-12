import type { PresignedUploadResponse } from "@/lib/validations/datasets";

/**
 * Send a file to S3 with a presigned PUT: the raw file is the body and the signed headers
 * are sent unchanged.
 *
 * `XMLHttpRequest` rather than `fetch`, for one reason: `fetch` reports no upload progress,
 * so a transfer can only ever be drawn as a spinner. This one reports bytes sent and can be
 * aborted, which is what lets the upload leave the dialog and run in the background.
 */
export function uploadFileToS3(
  file: File,
  presigned: PresignedUploadResponse,
  options?: {
    onProgress?: (sent: number, total: number) => void;
    /** Aborts the transfer. The request is cancelled, not merely ignored. */
    signal?: AbortSignal;
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    /**
     * Cancelled before this was even reached.
     *
     * The presign call is awaited first, and an abort during it leaves a signal that has
     * already fired: adding a listener now would wait for a second `abort` that never comes,
     * and the whole file would upload after being cancelled.
     */
    if (options?.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const request = new XMLHttpRequest();
    request.open("PUT", presigned.url);
    Object.entries(presigned.headers).forEach(([name, value]) => {
      request.setRequestHeader(name, value);
    });

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options?.onProgress?.(event.loaded, event.total);
    });
    request.addEventListener("load", () => {
      // S3 answers a presigned PUT with 200, and any 2xx is a success here.
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`S3 upload failed with status ${request.status}`));
    });
    request.addEventListener("error", () => reject(new Error("S3 upload failed")));
    request.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));

    options?.signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}
