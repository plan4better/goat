"use client";

import { Alert, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { CustomDomain } from "@/lib/validations/customDomain";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Domain löschen": says what goes offline when the domain is assigned. */
export function DeleteDomainDialog({
  domain,
  onClose,
  onConfirm,
}: {
  domain: CustomDomain;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  const assigned = Boolean(domain.assigned_project_id);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      toast.error(t("settings_domains_delete_error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.TRASH}
      tone="warning"
      title={t("settings_domains_delete_title")}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_domains_delete_confirm")}
          primaryColor="error"
          primaryLoading={busy}
          onPrimary={() => void confirm()}
        />
      }>
      <Stack spacing={3}>
        <Typography variant="body2">
          {t("settings_domains_delete_intro", { domain: domain.base_domain, ...PLAIN })}
        </Typography>
        {assigned ? (
          <>
            <Alert severity="warning">
              {t("settings_domains_delete_assigned", {
                project: domain.assigned_project_name ?? "",
                ...PLAIN,
              })}
            </Alert>
            <Typography variant="body2" component="ul" sx={{ m: 0, pl: 5 }}>
              <li>{t("settings_domains_delete_point_unassign")}</li>
              <li>{t("settings_domains_delete_point_cert")}</li>
              <li>{t("settings_domains_delete_point_serve")}</li>
            </Typography>
          </>
        ) : (
          <Typography variant="body2">{t("settings_domains_delete_free")}</Typography>
        )}
      </Stack>
    </AppDialog>
  );
}

export default DeleteDomainDialog;
