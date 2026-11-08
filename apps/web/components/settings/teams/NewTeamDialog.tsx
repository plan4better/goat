"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Stack } from "@mui/material";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { statusOf } from "@/lib/api/apiError";
import { createTeam } from "@/lib/api/teams";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";
import { type TeamFormValues, teamFormSchema } from "@/components/settings/teams/teamName";

const FORM_ID = "settings-new-team-form";
const PLAIN = { interpolation: { escapeValue: false } } as const;

/** "Neues Team": the caller becomes its owner; Enter in the name creates it. */
export default function NewTeamDialog({
  takenNames,
  onClose,
  onCreated,
}: {
  takenNames: string[];
  onClose: () => void;
  onCreated: (team: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation("common");
  const schema = useMemo(() => teamFormSchema(takenNames), [takenNames]);
  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isValid, isSubmitting, dirtyFields, touchedFields },
  } = useForm<TeamFormValues>({
    mode: "onChange",
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "" },
  });
  const shown = (field: keyof TeamFormValues) =>
    errors[field]?.message && (dirtyFields[field] || touchedFields[field])
      ? t(errors[field]!.message!)
      : undefined;

  const submit = handleSubmit(async (values) => {
    try {
      const team: { id: string; name: string } = await createTeam({
        name: values.name,
        description: values.description.trim() || undefined,
      });
      toast.success(t("settings_teams_created", { name: team.name, ...PLAIN }));
      onCreated(team);
    } catch (error) {
      // Core checks every team of the organization, also those the caller does not see.
      if (statusOf(error) === 409) setError("name", { type: "server", message: "settings_teams_name_taken" });
      else toast.error(t("settings_teams_create_error"));
    }
  });

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.USERS}
      title={t("settings_teams_new_title")}
      subtitle={t("settings_teams_new_subtitle")}
      maxWidth={560}
      closeDisabled={isSubmitting}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={isSubmitting}
          primaryLabel={t("settings_teams_create")}
          primaryType="submit"
          primaryForm={FORM_ID}
          onPrimary={() => void submit()}
          primaryDisabled={!isValid}
          primaryLoading={isSubmitting}
        />
      }>
      <Stack
        component="form"
        id={FORM_ID}
        spacing={5}
        noValidate
        sx={{ pt: 1 }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
        <LabeledField
          id="new-team-name"
          label={t("settings_teams_name")}
          required
          autoFocus
          placeholder={t("settings_teams_name_placeholder")}
          {...register("name")}
          error={shown("name")}
          help={t("settings_teams_name_help")}
          // The schema checks the trimmed name, so the counter counts it too.
          counter={{ value: (watch("name") ?? "").trim().length, max: 50 }}
        />
        <LabeledField
          id="new-team-description"
          label={t("settings_teams_description")}
          multiline
          minRows={3}
          placeholder={t("settings_teams_description_placeholder")}
          {...register("description")}
          error={shown("description")}
          help={t("settings_teams_description_help")}
          counter={{ value: (watch("description") ?? "").length, max: 250 }}
        />
      </Stack>
    </AppDialog>
  );
}
