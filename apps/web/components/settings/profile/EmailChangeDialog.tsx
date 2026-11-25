"use client";

import { DialogContentText } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

/** "E-Mail-Adresse ändern": saving a new address signs the user out. */
export default function EmailChangeDialog({
  email,
  onCancel,
  onConfirm,
}: {
  email: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  return (
    <AppDialog
      open
      onClose={onCancel}
      icon={ICON_NAME.EMAIL}
      title={t("settings_profile_email_dialog_title")}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onCancel}
          cancelDisabled={busy}
          primaryLabel={t("settings_profile_email_dialog_confirm")}
          primaryLoading={busy}
          onPrimary={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        />
      }>
      <DialogContentText>
        {t("settings_profile_email_dialog_body", { email, interpolation: { escapeValue: false } })}
      </DialogContentText>
    </AppDialog>
  );
}
