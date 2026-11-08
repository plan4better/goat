"use client";

import { Box, Skeleton, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import * as z from "zod";

import { statusOf } from "@/lib/api/apiError";
import { teamsScopeOf, updateTeam, useTeamMembers, useTeams } from "@/lib/api/teams";
import { useUserProfile } from "@/lib/api/users";
import type { Team } from "@/lib/validations/team";

import LabeledField from "@/components/common/LabeledField";
import CardSaveBar from "@/components/settings/common/CardSaveBar";
import ImagePicker from "@/components/settings/common/ImagePicker";
import SettingsCard from "@/components/settings/common/SettingsCard";
import { personName } from "@/components/settings/common/personName";
import { useCardForm } from "@/components/settings/common/useCardForm";
import { teamFormSchema } from "@/components/settings/teams/teamName";

const FORM_ID = "settings-team-profile-form";

const Term = ({ children }: { children: ReactNode }) => (
  <Typography component="dt" variant="body2" sx={{ fontWeight: 700, color: "text.secondary" }}>
    {children}
  </Typography>
);

const Detail = ({ children }: { children: ReactNode }) => (
  <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0, overflowWrap: "anywhere" }}>
    {children}
  </Typography>
);

/** Teamprofil: editable for those who may rename the team (`canEditTeam`),
 * read-only otherwise. The name must not be another team's the caller sees
 * (owners and admins see every team of the organization); core checks them all. */
export default function TeamProfileCard({
  team,
  canEdit,
  isTeamOwner,
  onSaved,
}: {
  team: Team;
  canEdit: boolean;
  /** A team owner who may not edit is a Betrachter: the hint says so. */
  isTeamOwner: boolean;
  /** Reads the team and the team list again. */
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const { userProfile } = useUserProfile();
  const scope = teamsScopeOf(userProfile?.roles);
  const { teams } = useTeams({ scope, enabled: scope !== undefined });
  const { teamMembers, isLoading: membersLoading } = useTeamMembers(team.id);
  // Names core refused as taken (409: a team the caller does not see) count as
  // taken too, so the field says so as Neues Team does, until the name changes.
  const [refused, setRefused] = useState<string[]>([]);
  const taken = useMemo(
    () => [...teams.filter((other) => other.id !== team.id).map((other) => other.name), ...refused],
    [teams, team.id, refused]
  );
  // The saved name stays valid even when another team shares it (P2-15).
  const schema = useMemo(
    () => teamFormSchema(taken, team.name).extend({ avatar: z.string() }),
    [taken, team.name]
  );
  const values = useMemo(
    () => ({ name: team.name ?? "", description: team.description ?? "", avatar: team.avatar ?? "" }),
    [team.name, team.description, team.avatar]
  );
  const card = useCardForm(schema, values, async ({ avatar, ...rest }) => {
    try {
      // Without a picture the field is left out: core keeps NULL instead of storing "".
      await updateTeam(team.id, avatar ? { avatar, ...rest } : rest);
      await onSaved();
      toast.success(t("settings_team_saved"));
      return true;
    } catch (error) {
      // Core checks every team of the organization, also those the caller does not see.
      if (statusOf(error) === 409) setRefused((names) => [...names, rest.name]);
      else toast.error(t("settings_team_save_error"));
      return false;
    }
  });
  // The schema with the refused name checks the field again.
  const { trigger } = card.form;
  useEffect(() => {
    if (refused.length > 0) void trigger("name");
  }, [refused, trigger]);
  const title = t("settings_team_profile_title");

  if (!canEdit) {
    const owner = teamMembers.find((member) => member.role === "team-owner");
    return (
      <SettingsCard
        title={title}
        hint={t(isTeamOwner ? "settings_team_profile_viewer_hint" : "settings_team_profile_readonly_hint")}>
        <Box
          component="dl"
          sx={{
            m: 0,
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "160px minmax(0, 1fr)" },
            rowGap: { xs: 1, md: 3 },
            columnGap: 6,
          }}>
          <Term>{t("settings_teams_name")}</Term>
          <Detail>{team.name}</Detail>
          <Term>{t("settings_teams_description")}</Term>
          <Detail>{team.description || t("settings_team_no_description")}</Detail>
          {/* A team whose owner left the organization has none until an owner or admin names one. */}
          {(membersLoading || owner) && (
            <>
              <Term>{t("settings_team_owner_label")}</Term>
              <Detail>{owner ? personName(owner) : <Skeleton variant="text" width={120} />}</Detail>
            </>
          )}
        </Box>
      </SettingsCard>
    );
  }

  const { register, watch, setValue } = card.form;
  return (
    <SettingsCard
      title={title}
      hint={t("settings_team_profile_hint")}
      footer={
        <CardSaveBar
          formId={FORM_ID}
          dirty={card.dirty}
          valid={card.valid}
          saving={card.saving}
          onDiscard={card.discard}
        />
      }>
      <Stack component="form" id={FORM_ID} spacing={5} noValidate onSubmit={card.submit}>
        <ImagePicker
          id="team-avatar"
          name={watch("name") || team.name}
          seed={team.name}
          variant="rounded"
          value={watch("avatar")}
          onChange={(url) => setValue("avatar", url, { shouldDirty: true, shouldValidate: true })}
          buttonLabel={t("settings_profile_upload")}
          hint={t("settings_team_picture_hint")}
        />
        <LabeledField
          id="team-name"
          label={t("settings_teams_name")}
          required
          {...register("name")}
          error={card.errorOf("name")}
          help={t("settings_teams_name_help")}
          // As it is saved (and as NewTeamDialog counts it): without the spaces around it.
          counter={{ value: (watch("name") ?? "").trim().length, max: 50 }}
        />
        <LabeledField
          id="team-description"
          label={t("settings_teams_description")}
          placeholder={t("settings_team_description_placeholder")}
          {...register("description")}
          error={card.errorOf("description")}
          counter={{ value: (watch("description") ?? "").length, max: 250 }}
        />
      </Stack>
    </SettingsCard>
  );
}
