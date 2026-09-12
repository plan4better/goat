import { useCallback } from "react";
import { detectBundleType, requestBundleImport } from "@/lib/api/bundles";
import { requestDatasetUpload } from "@/lib/api/datasets";
import { createLayer } from "@/lib/api/layers";
import { useJobs } from "@/lib/api/processes";
import { uploadFileToS3 } from "@/lib/services/s3";
import { addRunningJobIds } from "@/lib/store/jobs/slice";
import {
  transferCleared,
  transferFailed,
  transferHandedOff,
  transferProgress,
  transferStarted,
} from "@/lib/store/uploads/slice";
import { createLayerFromDatasetSchema } from "@/lib/validations/layer";

import { useAppDispatch } from "@/hooks/store/ContextHooks";

/**
 * The controller for each live transfer, so anything holding an id can cancel it.
 *
 * Module-level rather than in the store: an `AbortController` is not serialisable and has no
 * business in Redux. The store holds what the transfer *is*; this holds the handle to stop it.
 */
const controllers = new Map<string, AbortController>();

/** Abort a transfer. Silent if it has already finished — there is nothing to stop. */
export const cancelTransfer = (id: string): void => {
  controllers.get(id)?.abort();
  controllers.delete(id);
};

export type DatasetImportRequest = {
  file: File;
  name: string;
  description?: string;
  folderId?: string;
  projectId?: string;
  /** Spreadsheets only, and only when someone has answered for them. */
  hasHeader?: boolean;
  sheetName?: string;
  /** Bundle types that depend on one — a GTFS feed links to the street network
   *  its stop-to-street linkage is built against. */
  streetNetworkBundleId?: string;
};

/**
 * Presign, transfer, create the layer, hand the job to the tray.
 *
 * The one import path, called by the upload dialog and by a drop on the map, so a dropped
 * file inherits the same validation and the same completion toast rather than growing a
 * second implementation beside it.
 *
 * It does not await the transfer on the caller's behalf — the returned promise resolves when
 * the job has been created, and callers that should not wait simply do not await it. That is
 * what lets a dialog close the moment it has handed the file over.
 */
export const useDatasetImport = () => {
  const dispatch = useAppDispatch();
  const { mutate: mutateJobs } = useJobs({ read: false });

  const importDataset = useCallback(
    async (request: DatasetImportRequest): Promise<string | undefined> => {
      const { file } = request;
      // Unique per transfer without a server id: two drops of the same file are two rows.
      const id = `${file.name}-${file.size}-${performance.now()}`;
      dispatch(transferStarted({ id, fileName: file.name, total: file.size }));
      const controller = new AbortController();
      controllers.set(id, controller);

      try {
        const presigned = await requestDatasetUpload({
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          file_size: file.size,
        });
        await uploadFileToS3(file, presigned, {
          onProgress: (sent) => dispatch(transferProgress({ id, sent })),
          signal: controller.signal,
        });

        // A recognised bundle (e.g. a GTFS feed) imports as a bundle — one
        // upload becoming several linked layers — instead of a single layer.
        // The backend re-infers the type from the file, so this only routes.
        const bundleType = detectBundleType(file);
        let jobId: string | undefined;
        if (bundleType) {
          const response = await requestBundleImport({
            s3_key: presigned.key,
            folder_id: request.folderId as string,
            name: request.name,
            description: request.description,
            ...(request.projectId && { project_id: request.projectId }),
            ...(request.streetNetworkBundleId && {
              street_network_bundle_id: request.streetNetworkBundleId,
            }),
          });
          jobId = response.job_id ?? undefined;
        } else {
          const payload = createLayerFromDatasetSchema.parse({
            name: request.name,
            description: request.description,
            folder_id: request.folderId,
            s3_key: presigned.key,
            ...(request.hasHeader !== undefined && { has_header: request.hasHeader }),
            ...(request.sheetName && { sheet_name: request.sheetName }),
          });
          const response = await createLayer(payload, request.projectId);
          jobId = response?.jobID;
        }

        dispatch(transferHandedOff({ id, jobId }));
        if (jobId) {
          /**
           * Revalidated twice, deliberately.
           *
           * `useJobs` polls only while the payload it last fetched contains a running or
           * accepted job — otherwise its interval is 0 and it stops. A revalidation issued
           * the instant `createLayer` returns can beat the job into the list, and then
           * nothing polls and the job's toast waits for an unrelated event. The second pass
           * catches it and starts the 2s cadence.
           */
          mutateJobs();
          setTimeout(() => void mutateJobs(), 1500);
          dispatch(addRunningJobIds([jobId]));
        }
        return jobId;
      } catch (error) {
        // An abort is someone cancelling, not a failure to report.
        const aborted = error instanceof DOMException && error.name === "AbortError";
        // Someone cancelled: the row goes, rather than lingering as a failure they caused
        // on purpose.
        if (aborted) {
          dispatch(transferCleared(id));
          return undefined;
        }
        // No toast here: the transfer's own toast turns red and says the same thing. Both
        // firing meant two notifications for one failure.
        dispatch(transferFailed({ id, error: String(error) }));
        console.error("dataset import failed", error);
        return undefined;
      } finally {
        controllers.delete(id);
      }
    },
    [dispatch, mutateJobs]
  );

  return { importDataset };
};
