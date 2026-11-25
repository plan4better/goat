"use client";

import { Alert, Link, Stack, Typography } from "@mui/material";
import NextLink from "next/link";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { statusOf } from "@/lib/api/apiError";
import { deleteTeam } from "@/lib/api/teams";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Team löschen". Core refuses while the team's space holds anything, trash
 * included (F5): the dialog stays open and says so, with the way to the space. */
export default function DeleteTeamDialog({
  teamId,
  teamName,
  spaceHref,
  onClose,
  onDeleted,
}: {
  teamId: string;
  teamName: string;
  /** The team's space under Inhalte, when it is among the caller's spaces. */
  spaceHref?: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteTeam(teamId);
      onDeleted();
    } catch (error) {
      if (statusOf(error) === 409) setConflict(true);
      else toast.error(t("settings_team_delete_error"));
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
      title={t("settings_team_delete_title")}
      closeDisabled={busy}
      notice={
        conflict ? (
          <Alert severity="error" role="alert">
            {t("settings_team_delete_conflict")}{" "}
            {spaceHref && (
              <Link component={NextLink} href={spaceHref} color="inherit" sx={{ fontWeight: 700 }}>
                {t("settings_team_open_space")}
              </Link>
            )}
          </Alert>
        ) : undefined
      }
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_team_delete_confirm")}
          primaryColor="error"
          primaryLoading={busy}
          onPrimary={() => void remove()}
        />
      }>
      <Stack spacing={2}>
        <Typography variant="body2">
          {t("settings_team_delete_question", { team: teamName, ...PLAIN })}
        </Typography>
        <Typography variant="body2" component="ul" sx={{ m: 0, pl: 5 }}>
          <li>{t("settings_team_delete_point_shares")}</li>
          <li>{t("settings_team_delete_point_personal")}</li>
        </Typography>
        <Typography variant="body2" fontWeight={700}>
          {t("settings_team_delete_final")}
        </Typography>
      </Stack>
    </AppDialog>
  );
}
