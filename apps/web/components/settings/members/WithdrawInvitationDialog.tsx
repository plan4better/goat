"use client";

import { Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { deleteInvitation } from "@/lib/api/organizations";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import { roleWords } from "@/components/settings/common/roleWords";
import type { MemberRow } from "@/components/settings/members/memberRows";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Einladung zurückziehen": the link in the mail stops working, the seat is free at once. */
export default function WithdrawInvitationDialog({
  organizationId,
  invitation,
  onClose,
  onWithdrawn,
}: {
  organizationId: string;
  invitation: MemberRow;
  onClose: () => void;
  /** Reads the list and the organization again. */
  onWithdrawn: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);

  const withdraw = async () => {
    setBusy(true);
    try {
      await deleteInvitation(organizationId, invitation.id);
      await onWithdrawn();
      onClose();
    } catch {
      toast.error(t("settings_members_withdraw_error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.EMAIL}
      tone="warning"
      title={t("settings_members_withdraw_title")}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_members_withdraw_confirm")}
          primaryColor="error"
          primaryLoading={busy}
          onPrimary={() => void withdraw()}
        />
      }>
      <Stack spacing={3}>
        <div>
          <Typography fontWeight={700} sx={{ overflowWrap: "anywhere" }}>
            {invitation.email}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("settings_members_withdraw_role", { role: roleWords(t)[invitation.role].word, ...PLAIN })}
          </Typography>
        </div>
        <Typography variant="body2">{t("settings_members_withdraw_body")}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t(
            invitation.role === "organization-viewer"
              ? "settings_members_withdraw_seat_viewer"
              : "settings_members_withdraw_seat_editor"
          )}
        </Typography>
      </Stack>
    </AppDialog>
  );
}
