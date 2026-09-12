"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { detectBundleType } from "@/lib/api/bundles";
import { useProject } from "@/lib/api/projects";

import { useDatasetImport } from "@/hooks/addLayer/useDatasetImport";

import AddLayerDialog from "@/components/addLayer/AddLayerDialog";

/**
 * Formats that need an answer before they can be imported: which row is the header, and
 * which worksheet. Guessing produces a plausible, wrong layer, so these open the dialog.
 */
const NEEDS_SETUP = ["csv", "xlsx", "xls"];

/** Formats that carry their own geometry and fields, so there is nothing to ask. */
const IMPORTS_DIRECTLY = ["gpkg", "geojson", "kml", "zip", "parquet"];

const extensionOf = (file: File): string => file.name.split(".").pop()?.toLowerCase() ?? "";

/**
 * Whether a drop landed inside a dialog, drawer, menu or popover.
 *
 * By MUI's own container class rather than by a flag each of them sets: this
 * listens on the window, so it sees drops meant for anything layered over the
 * editor, and the layer should not have to know that a global listener exists.
 */
const OVERLAY_SELECTOR = [
  ".MuiModal-root",
  ".MuiDialog-root",
  ".MuiDrawer-root",
  ".MuiPopover-root",
  ".MuiMenu-root",
].join(",");

const insideModal = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest(OVERLAY_SELECTOR);

/**
 * Drop a file anywhere on the editor to import it.
 *
 * Nothing is drawn while dragging. The window takes the drop directly, and what tells you it
 * worked is the transfer banner appearing — an editor-sized panel lighting up green under the
 * cursor is a lot of screen for a message that arrives a moment later anyway.
 *
 * One file at a time, matching the upload dialog: several are refused rather than importing
 * whichever the browser happened to list first.
 */
const MapDropTarget = ({ projectId }: { projectId: string }) => {
  const { t } = useTranslation("common");
  const { importDataset } = useDatasetImport();
  const { project } = useProject(projectId);
  const [needsSetup, setNeedsSetup] = useState<File | null>(null);

  const take = useCallback(
    (files: FileList | null) => {
      const dropped = Array.from(files ?? []);
      if (dropped.length === 0) return;
      if (dropped.length > 1) {
        toast.warning(t("drop_one_file_only"));
        return;
      }

      const file = dropped[0];
      const extension = extensionOf(file);

      if (NEEDS_SETUP.includes(extension)) {
        setNeedsSetup(file);
        return;
      }
      // A bundle type that has to be linked to another bundle cannot be
      // imported from a drop alone: a GTFS feed's stop-to-street linkage is
      // built against a street network, and nothing here can pick one. So the
      // drop opens the dialog and the upload finishes there.
      if (detectBundleType(file)?.requiresStreetNetwork) {
        setNeedsSetup(file);
        return;
      }
      if (!IMPORTS_DIRECTLY.includes(extension)) {
        toast.error(t("drop_unsupported_file"));
        return;
      }

      void importDataset({
        file,
        // The filename without its extension, as the dialog would have suggested.
        name: file.name.replace(/\.[^/.]+$/, ""),
        folderId: project?.folder_id,
        projectId,
      });
    },
    [importDataset, project?.folder_id, projectId, t]
  );

  useEffect(() => {
    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    // `dragover` must be prevented for a drop to be allowed at all, and only for files —
    // otherwise this swallows the panel's own drag-to-reorder.
    const onDragOver = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser navigates to the file it was handed — so it
      // is prevented for every drop, including the ones this ignores.
      event.preventDefault();
      // A drop inside a dialog belongs to the dialog. Its own drop zone has
      // already taken the file by now (React's handler runs before this one,
      // which listens on the window), so importing it here would import it
      // twice; and a drop on the dialog's padding, where it has no zone,
      // would import to the map behind whatever the dialog is asking.
      if (insideModal(event.target)) return;
      take(event.dataTransfer?.files ?? null);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [take]);

  // The file has not been uploaded: it is waiting for an answer. A spreadsheet
  // opens with its column setup already showing, since there is one file and
  // one thing to configure; a bundle needs a field on the dialog itself, so
  // that one opens plain.
  if (!needsSetup) return null;
  return (
    <AddLayerDialog
      source="upload"
      projectId={projectId}
      defaultFolderId={project?.folder_id}
      initialFile={needsSetup}
      autoOpenSetup={NEEDS_SETUP.includes(extensionOf(needsSetup))}
      onClose={() => setNeedsSetup(null)}
    />
  );
};

export default MapDropTarget;
