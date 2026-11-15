import CloseIcon from "@mui/icons-material/Close";
import { Box, Button, IconButton, Stack, Typography } from "@mui/material";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { uploadAsset } from "@/lib/api/assets";
import { ASSETS_MAX_FILE_SIZE_MB, assetTypeEnum } from "@/lib/validations/assets";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";
import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";

type UploadIconDialogProps = {
  open: boolean;
  onClose: () => void;
  onUploaded?: () => void; // optional callback to refresh UI
};

export const UploadIconDialog = ({ open, onClose, onUploaded }: UploadIconDialogProps) => {
  const { t } = useTranslation("common");
  const [isBusy, setIsBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] || null;

    if (f) {
      const maxSize = ASSETS_MAX_FILE_SIZE_MB * 1024 * 1024; // in bytes
      if (f.size > maxSize) {
        toast.error(`${t("maximum_image_size_is")} ${ASSETS_MAX_FILE_SIZE_MB}MB`);
        handleClearFile();
        return;
      }

      setFile(f);
      const reader = new FileReader();
      reader.onloadend = () => setPreview(reader.result as string);
      reader.readAsDataURL(f);
    } else {
      setFile(null);
      setPreview(null);
    }
  };

  const handleClearFile = () => {
    setFile(null);
    setPreview(null);
    setDisplayName("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    if (!file) return;
    setIsBusy(true);
    try {
      await uploadAsset(file, assetTypeEnum.Enum.icon, {
        displayName,
      });
      if (onUploaded) onUploaded();
      onClose();
      handleClearFile();
      setDisplayName("");
    } catch (err) {
      toast.error(t("icon_upload_failed"));
    } finally {
      setIsBusy(false);
    }
  };

  const handleOnClose = () => {
    onClose();
    handleClearFile();
  };

  return (
    <AppDialog
      open={open}
      onClose={handleOnClose}
      icon={ICON_NAME.UPLOAD}
      title={t("upload_icon")}
      maxWidth={600}
      footer={
        <AppDialogFooter
          onCancel={handleOnClose}
          primaryLabel={t("upload")}
          onPrimary={() => void handleSubmit()}
          primaryDisabled={!file || !displayName.trim()}
          primaryLoading={isBusy}
        />
      }>
      <SectionHeader
        active
        alwaysActive
        label={t("add_icon")}
        icon={ICON_NAME.CIRCLE}
        disableAdvanceOptions
      />
      <SectionOptions
        active={true}
        baseOptions={
          <>
            <Typography variant="body2" sx={{ mb: 2 }}>
              <Trans i18nKey="common:choose_icon_message" components={{ b: <b /> }} />
            </Typography>
            {/* Hidden file input */}
            <input type="file" accept="image/*" hidden ref={fileInputRef} onChange={handleFileChange} />
            {/* File picker section */}
            {!file ? (
              <Button
                variant="outlined"
                startIcon={<Icon iconName={ICON_NAME.IMAGE} />}
                onClick={() => fileInputRef.current?.click()}>
                {t("upload_icon")}
              </Button>
            ) : (
              <Stack
                direction="row"
                spacing={2}
                alignItems="center"
                justifyContent="space-between"
                sx={{ mb: 2 }}>
                {preview && (
                  <Box
                    component="img"
                    src={preview}
                    alt="preview"
                    sx={{
                      width: 60,
                      height: 60,
                      borderRadius: 1,
                      border: "1px solid",
                      borderColor: "divider",
                    }}
                  />
                )}
                <IconButton onClick={handleClearFile}>
                  <CloseIcon />
                </IconButton>
              </Stack>
            )}
          </>
        }
      />

      <SectionHeader
        active={!!file}
        alwaysActive
        label={t("assign_name")}
        icon={ICON_NAME.CIRCLE}
        disableAdvanceOptions
      />
      <SectionOptions
        active={!!file}
        baseOptions={
          <Stack spacing={2} sx={{ py: 2 }}>
            <LabeledField
              id="upload-icon-name"
              label={t("name")}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
              required
            />
          </Stack>
        }
      />
    </AppDialog>
  );
};
