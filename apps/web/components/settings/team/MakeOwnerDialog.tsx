"use client";

import { Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { detailOf, statusOf } from "@/lib/api/apiError";
import { changeTeamOwner } from "@/lib/api/teams";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";

const PLAIN = { interpolation: { escapeValue: false } } as const;
// Core's 400 for a new owner who is a Betrachter (`PUT /teams/{id}/owner`);
// its other 400 is a person no longer in the team.
const VIEWER_REFUSAL = "A viewer cannot own a team";

/** "Zum Eigentümer machen" (B7). No undo: once the caller hands the team over
 * they can no longer change it back. */
export default function MakeOwnerDialog({
  teamId,
  teamName,
  person,
  callerIsOwner,
  onClose,
  onChanged,
}: {
  teamId: string;
  teamName: string;
  person: { id: string; name: string };
  /** The caller hands their own team over: they stay a member. */
  callerIsOwner: boolean;
  onClose: () => void;
  /** Reads the team's members, the organization's members, the team (the
   * caller's role in it) and the team lists again. */
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await changeTeamOwner(teamId, person.id);
      // A failed reload must not hide that the owner changed.
      await onChanged().catch(() => undefined);
      toast.success(t("settings_team_owner_changed", { name: person.name, ...PLAIN }));
      onClose();
    } catch (error) {
      const status = statusOf(error);
      if (status === 400 || status === 409) {
        // What the dialog was opened on changed meanwhile: the person left the
        // team (400 before the click, 409 during it) or became a Betrachter.
        // Everything is read again, so the rows and their menus show what is
        // true now, and the dialog closes. Core's detail is English, so the
        // text is the page's own.
        const viewer = detailOf(error) === VIEWER_REFUSAL;
        toast.error(
          t(viewer ? "settings_team_owner_refused_viewer" : "settings_team_owner_refused_gone", {
            name: person.name,
            ...PLAIN,
          })
        );
        await onChanged().catch(() => undefined);
        onClose();
        return;
      }
      toast.error(t("settings_team_owner_error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.CROWN}
      title={t("settings_team_owner_title")}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_team_owner_confirm")}
          primaryLoading={busy}
          onPrimary={() => void confirm()}
        />
      }>
      <Stack spacing={2}>
        <Typography variant="body2">
          {t("settings_team_owner_body", { name: person.name, team: teamName, ...PLAIN })}
        </Typography>
        {callerIsOwner && <Typography variant="body2">{t("settings_team_owner_you_stay")}</Typography>}
      </Stack>
    </AppDialog>
  );
}
