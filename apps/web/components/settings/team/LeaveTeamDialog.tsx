"use client";

import { Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { deleteMember } from "@/lib/api/teams";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Team verlassen": removes the caller from the team (`DELETE /teams/{id}/users/{me}`,
 * F6); what they put in the team's space stays there. */
export default function LeaveTeamDialog({
  teamId,
  teamName,
  selfId,
  onClose,
  onLeft,
}: {
  teamId: string;
  teamName: string;
  selfId: string;
  onClose: () => void;
  onLeft: () => void;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    setBusy(true);
    try {
      await deleteMember(teamId, selfId);
      toast.success(t("settings_team_left", { team: teamName, ...PLAIN }));
      onLeft();
    } catch {
      toast.error(t("settings_team_leave_error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.SIGNOUT}
      tone="warning"
      title={t("settings_team_leave_title")}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_team_leave_confirm")}
          primaryColor="error"
          primaryLoading={busy}
          onPrimary={() => void leave()}
        />
      }>
      <Stack spacing={2}>
        <Typography variant="body2">
          {t("settings_team_leave_question", { team: teamName, ...PLAIN })}
        </Typography>
        <Typography variant="body2" component="ul" sx={{ m: 0, pl: 5 }}>
          <li>{t("settings_team_leave_point_content")}</li>
          <li>{t("settings_team_leave_point_back")}</li>
        </Typography>
      </Stack>
    </AppDialog>
  );
}
