"use client";

import { Stack } from "@mui/material";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import * as z from "zod";

import { updateOrganization } from "@/lib/api/organizations";
import { useOrganization } from "@/lib/api/users";

import LabeledField from "@/components/common/LabeledField";
import CardSaveBar from "@/components/settings/common/CardSaveBar";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import ImagePicker from "@/components/settings/common/ImagePicker";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import { useCardForm } from "@/components/settings/common/useCardForm";

const schema = z.object({
  name: z.string().trim().min(1, "settings_org_name_required").max(50, "settings_org_name_too_long"),
  avatar: z.string(),
});
type Values = z.infer<typeof schema>;
const FORM_ID = "settings-organization-form";

/** Name und Logo (owners and admins); the nav's group header follows the save. */
export default function NameLogoCard() {
  const { t } = useTranslation("common");
  const { organization, isError, mutate } = useOrganization();
  const values = useMemo<Values | undefined>(
    () => organization && { name: organization.name ?? "", avatar: organization.avatar ?? "" },
    [organization]
  );
  const card = useCardForm(schema, values, async ({ avatar, ...rest }) => {
    if (!organization) return false;
    try {
      // Without a logo the field is left out: core keeps NULL instead of storing "".
      await updateOrganization(organization.id, avatar ? { avatar, ...rest } : rest);
      await mutate();
      return true;
    } catch {
      toast.error(t("settings_org_save_error"));
      return false;
    }
  });

  const title = t("settings_org_name_logo_title");
  const hint = t("settings_org_name_logo_hint");
  if (!organization) {
    return isError ? (
      <SettingsCard title={title} hint={hint}>
        <SettingsLoadError onRetry={() => void mutate()} />
      </SettingsCard>
    ) : (
      <CardSkeleton title={title} hint={hint} rows={2} help footer />
    );
  }
  const { register, watch, setValue } = card.form;

  return (
    <SettingsCard
      title={title}
      hint={hint}
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
          id="organization-avatar"
          name={watch("name") || organization.name}
          seed={organization.id}
          variant="rounded"
          value={watch("avatar")}
          onChange={(url) => setValue("avatar", url, { shouldDirty: true, shouldValidate: true })}
          buttonLabel={t("settings_org_upload_logo")}
          hint={t("settings_org_logo_hint")}
        />
        <LabeledField
          id="organization-name"
          label={t("settings_org_name")}
          required
          {...register("name")}
          error={card.errorOf("name")}
          help={t("settings_org_name_help")}
        />
      </Stack>
    </SettingsCard>
  );
}
