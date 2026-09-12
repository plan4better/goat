import { Box, Stack, Typography } from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { useSpaces } from "@/lib/api/content";
import { requestDatasetUpload } from "@/lib/api/datasets";
import { useFolders } from "@/lib/api/folders";
import { executeProcessAsync } from "@/lib/api/processes";
import { uploadFileToS3 } from "@/lib/services/s3";
import { setRunningJobIds } from "@/lib/store/jobs/slice";
import { homeFolderOf, spaceDisplayName } from "@/lib/utils/content";
import type { Space } from "@/lib/validations/content";

import type { SelectorItem } from "@/types/map/common";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import ChosenFileRow from "@/components/addLayer/ChosenFileRow";
import UploadDropzone from "@/components/addLayer/UploadDropzone";
import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import FolderBrowser from "@/components/dashboard/common/FolderBrowser";
import Selector from "@/components/map/panels/common/Selector";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";

interface ProjectImportModalProps {
  open: boolean;
  /** Pre-selects the destination folder — the one the caller is browsing.
   * Read once, when spaces and folders are in hand: a caller that needs it
   * to follow the current folder mounts a fresh modal per open. */
  defaultFolderId?: string;
  onClose?: () => void;
  onImportStarted?: () => void;
}

const ProjectImportModal: React.FC<ProjectImportModalProps> = ({
  open,
  defaultFolderId,
  onClose,
  onImportStarted,
}) => {
  const { t } = useTranslation("common");
  const { folders } = useFolders();
  const { spaces } = useSpaces();
  const dispatch = useAppDispatch();
  const runningJobIds = useAppSelector((state) => state.jobs.runningJobIds);
  const [isBusy, setIsBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [projectName, setProjectName] = useState("");
  const [space, setSpace] = useState<Space | null>(null);
  /** The folder browsed to inside the space; `null` is the space root, which
   * imports into that space's own `home` folder. */
  const [browsedFolderId, setBrowsedFolderId] = useState<string | null>(null);

  // Seeded once the lists are in: the folder being browsed picks its space
  // and stands as the browsed folder; without one the personal space at
  // its root is where a project lands by default.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || spaces.length === 0) return;
    if (defaultFolderId && !folders) return;
    const defaultFolder = defaultFolderId
      ? folders?.find((folder) => folder.id === defaultFolderId)
      : undefined;
    const spaceFromFolder = defaultFolder
      ? spaces.find((candidate) => candidate.id === defaultFolder.space_id)
      : undefined;
    const chosen = spaceFromFolder ?? spaces.find((candidate) => candidate.kind === "personal") ?? spaces[0];
    seeded.current = true;
    setSpace(chosen);
    if (defaultFolder && spaceFromFolder && defaultFolder.name !== "home")
      setBrowsedFolderId(defaultFolder.id);
  }, [spaces, folders, defaultFolderId]);

  const homeFolderId = space ? (homeFolderOf(folders ?? [], space.id)?.id ?? null) : null;
  /** What the import actually writes to — the browsed folder, or the space's
   * `home` folder at the root. */
  const targetFolderId = browsedFolderId ?? homeFolderId;

  const spaceItems: SelectorItem[] = useMemo(
    () => spaces.map((candidate) => ({ value: candidate.id, label: spaceDisplayName(candidate, t) })),
    [spaces, t]
  );
  const spaceItem = space ? { value: space.id, label: spaceDisplayName(space, t) } : undefined;

  const handleOnClose = () => {
    setFile(null);
    setFileError(undefined);
    setProjectName("");
    onClose?.();
  };

  const handleFileChange = (picked: File | null) => {
    setFileError(undefined);
    setFile(null);
    if (!picked) return;
    if (!picked.name.endsWith(".zip")) {
      setFileError(t("invalid_file_type"));
      return;
    }
    setFile(picked);
    // The name stays empty unless the user types one: the archive carries
    // the project's own name, and the file name is a sanitised copy of it
    // (parentheses and other characters stripped for the file system), so
    // pre-filling from it would rename the project on every import.
  };

  const allowSubmit = !!file && !!targetFolderId && !isBusy;

  const handleImport = async () => {
    if (!file || !targetFolderId) return;

    try {
      setIsBusy(true);

      // 1. Get presigned URL
      const presigned = await requestDatasetUpload({
        filename: file.name,
        content_type: "application/zip",
        file_size: file.size,
      });

      // 2. Upload to S3
      await uploadFileToS3(file, presigned);

      // 3. Trigger import job via OGC Processes, under the object key the
      //    file was stored at
      const job = await executeProcessAsync("project_import", {
        s3_key: presigned.key,
        target_folder_id: targetFolderId,
        ...(projectName ? { project_name: projectName } : {}),
      });

      if (job?.jobID) {
        dispatch(setRunningJobIds([...runningJobIds, job.jobID]));
      }
      toast.success(t("project_import_started"));
      onImportStarted?.();
      handleOnClose();
    } catch (_error) {
      toast.error(t("error_importing_project"));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onClose={handleOnClose}
      icon={ICON_NAME.UPLOAD}
      title={t("import_project")}
      maxWidth={600}
      footer={
        <AppDialogFooter
          onCancel={handleOnClose}
          primaryLabel={t("import")}
          onPrimary={() => void handleImport()}
          primaryDisabled={!allowSubmit}
          primaryLoading={isBusy}
        />
      }>
      <Stack direction="column" spacing={4} sx={{ my: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          {t("accepts_zip_files")}
        </Typography>

        {/* One archive at a time, so the zone is the empty state: once one is
            chosen it gives way to the row describing it, and removing the
            file brings the zone back. */}
        {file ? (
          <ChosenFileRow file={file} icon={ICON_NAME.MAP} onRemove={() => setFile(null)} disabled={isBusy} />
        ) : (
          <UploadDropzone accept={[".zip"]} error={fileError} onChange={handleFileChange} minHeight={180} />
        )}

        {file && (
          // TextFieldInput leaves its unfocused label colour to `inherit`, so
          // the box around it is what sets the house secondary.
          <Box sx={{ color: "text.secondary" }}>
            <TextFieldInput
              label={t("project_name")}
              value={projectName}
              onChange={setProjectName}
              placeholder={t("optional_rename_on_import")}
              disabled={isBusy}
              inputProps={{ "aria-label": t("project_name") }}
            />
          </Box>
        )}

        <Selector
          label={t("destination")}
          items={spaceItems}
          selectedItems={spaceItem}
          disabled={isBusy}
          setSelectedItems={(items) => {
            const picked = Array.isArray(items) ? items[0] : items;
            setSpace(spaces.find((candidate) => candidate.id === picked?.value) ?? null);
            setBrowsedFolderId(null);
          }}
        />

        {space && (
          <FolderBrowser
            space={space}
            folders={folders ?? []}
            homeFolderId={homeFolderId}
            value={browsedFolderId}
            onChange={setBrowsedFolderId}
            label={t("folder")}
            maxHeight={180}
            disabled={isBusy}
          />
        )}
      </Stack>
    </AppDialog>
  );
};

export default ProjectImportModal;
