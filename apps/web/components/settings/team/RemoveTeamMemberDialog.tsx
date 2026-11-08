"use client";

import { DialogContentText } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { deleteMember } from "@/lib/api/teams";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Aus dem Team entfernen": the person stays a member of the organization. */
export default function RemoveTeamMemberDialog({
  teamId,
  teamName,
  person,
  onClose,
  onRemoved,
}: {
  teamId: string;
  teamName: string;
  person: { id: string; name: string };
  onClose: () => void;
  /** Reads the team's members again. */
  onRemoved: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteMember(teamId, person.id);
      await onRemoved();
      toast.success(t("settings_team_removed", { name: person.name, ...PLAIN }));
      onClose();
    } catch {
      toast.error(t("settings_team_remove_error", { name: person.name, ...PLAIN }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.USERS}
      tone="warning"
      title={t("settings_team_remove_title")}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_team_remove_confirm")}
          primaryColor="error"
          primaryLoading={busy}
          onPrimary={() => void remove()}
        />
      }>
      <DialogContentText>
        {t("settings_team_remove_body", { name: person.name, team: teamName, ...PLAIN })}
      </DialogContentText>
    </AppDialog>
  );
}
