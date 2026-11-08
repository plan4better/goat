"use client";

import { Box, MenuItem, Stack, Typography } from "@mui/material";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { detailOf, statusOf } from "@/lib/api/apiError";
import { deleteMember } from "@/lib/api/organizations";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";
import UserAvatar from "@/components/dashboard/common/UserAvatar";
import type { MemberRow } from "@/components/settings/members/memberRows";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Mitglied entfernen": always names an heir for the person's personal
 * content (core needs one when there is any, F4), oneself by default. */
export default function RemoveMemberDialog({
  organizationId,
  organizationName,
  person,
  heirs,
  selfId,
  onClose,
  onRemoved,
}: {
  organizationId: string;
  organizationName: string;
  person: MemberRow;
  /** Active members other than `person`, oneself among them. */
  heirs: MemberRow[];
  selfId: string;
  onClose: () => void;
  /** Reads the list and the organization again. */
  onRemoved: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const [heir, setHeir] = useState(selfId);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await deleteMember(organizationId, person.id, heir);
      await onRemoved();
      toast.success(t("settings_members_removed", { name: person.name, ...PLAIN }));
      onClose();
    } catch (error) {
      // A 400 says why (the heir is no member any more): core's detail follows.
      const detail = statusOf(error) === 400 ? detailOf(error) : undefined;
      toast.error(
        [t("settings_members_remove_error", { name: person.name, ...PLAIN }), detail]
          .filter(Boolean)
          .join(" ")
      );
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
      title={t("settings_members_remove_title")}
      closeDisabled={busy}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={busy}
          primaryLabel={t("settings_members_remove_confirm")}
          primaryColor="error"
          primaryLoading={busy}
          onPrimary={() => void remove()}
        />
      }>
      <Stack spacing={4}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 3 }}>
          <UserAvatar id={person.id} name={person.name} src={person.avatar} size={40} />
          <Box sx={{ minWidth: 0 }}>
            <Typography fontWeight={700} noWrap>
              {person.name}
            </Typography>
            {person.name !== person.email && (
              <Typography variant="body2" color="text.secondary" noWrap>
                {person.email}
              </Typography>
            )}
          </Box>
        </Box>
        <Typography variant="body2">
          {t("settings_members_remove_question", {
            name: person.name,
            organization: organizationName,
            ...PLAIN,
          })}
        </Typography>
        <LabeledField
          id="remove-member-heir"
          select
          label={t("settings_members_heir_label")}
          value={heir}
          disabled={busy}
          onChange={(event) => setHeir(event.target.value)}
          help={t("settings_members_heir_help", { name: person.name, ...PLAIN })}>
          {heirs.map((candidate) => (
            <MenuItem key={candidate.id} value={candidate.id}>
              {candidate.id === selfId
                ? t("settings_members_heir_you", { name: candidate.name, ...PLAIN })
                : candidate.name}
            </MenuItem>
          ))}
        </LabeledField>
        <Typography variant="body2" color="text.secondary">
          {t(
            person.role === "organization-viewer"
              ? "settings_members_remove_note_viewer"
              : "settings_members_remove_note_editor"
          )}
        </Typography>
      </Stack>
    </AppDialog>
  );
}
