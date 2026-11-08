"use client";

import { Box, Stack } from "@mui/material";
import { signOut } from "next-auth/react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { statusOf } from "@/lib/api/apiError";
import { updateUserProfile, useUserProfile } from "@/lib/api/users";

import { DialogLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import LabeledField from "@/components/common/LabeledField";
import CardSaveBar from "@/components/settings/common/CardSaveBar";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import ImagePicker from "@/components/settings/common/ImagePicker";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import { useCardForm } from "@/components/settings/common/useCardForm";
import { type ProfileValues, profileSchema } from "@/components/settings/profile/profileSchema";

/** In place of the address dialog when its code does not load: cancelling is all it offers. */
function EmailChangeLoadFailed({ onCancel }: { onCancel: () => void }) {
  return <DialogLoadFailed onClose={onCancel} />;
}

// Loaded on first open. A dialog whose code does not load (a deploy since the
// page opened) shows a notice instead of taking the page down.
const EmailChangeDialog = dynamic(
  () => orLoadFailed(import("@/components/settings/profile/EmailChangeDialog"), EmailChangeLoadFailed),
  { ssr: false }
);
const FORM_ID = "settings-profile-form";

/** Persönliche Angaben: picture, names and address, saved from the card's
 * save bar; a new address is confirmed first and signs the user out. */
export default function PersonalCard() {
  const { t } = useTranslation("common");
  const { userProfile, isError, mutate } = useUserProfile();
  const [pending, setPending] = useState<ProfileValues | null>(null);
  const values = useMemo<ProfileValues | undefined>(
    () =>
      userProfile && {
        avatar: userProfile.avatar ?? "",
        firstname: userProfile.firstname ?? "",
        lastname: userProfile.lastname ?? "",
        email: userProfile.email ?? "",
      },
    [userProfile]
  );

  const persist = async ({ avatar, ...rest }: ProfileValues): Promise<boolean> => {
    try {
      // Without a picture the field is left out: core keeps NULL instead of storing "".
      await updateUserProfile(avatar ? { avatar, ...rest } : rest);
      await mutate();
      toast.success(t("settings_profile_saved"));
      return true;
    } catch (error) {
      // 502: core could not write to Keycloak and saved nothing.
      toast.error(
        t(statusOf(error) === 502 ? "settings_profile_keycloak_error" : "settings_profile_save_error")
      );
      return false;
    }
  };

  const card = useCardForm(profileSchema, values, async (next) => {
    if (values && next.email !== values.email) {
      setPending(next);
      return false;
    }
    return persist(next);
  });

  const title = t("settings_profile_personal_title");
  const hint = t("settings_profile_personal_hint");
  if (!userProfile) {
    return isError ? (
      <SettingsCard title={title} hint={hint}>
        <SettingsLoadError onRetry={() => void mutate()} />
      </SettingsCard>
    ) : (
      <CardSkeleton title={title} hint={hint} rows={3} />
    );
  }

  const { register, watch, setValue } = card.form;
  const email = watch("email") ?? "";
  const displayName = `${watch("firstname") ?? ""} ${watch("lastname") ?? ""}`.trim() || userProfile.email;

  const confirmEmailChange = async () => {
    if (!pending) return;
    if (await persist(pending)) {
      card.form.reset(pending);
      setPending(null);
      await signOut({ callbackUrl: process.env.NEXT_PUBLIC_APP_URL });
    }
  };

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
          id="profile-avatar"
          name={displayName}
          seed={userProfile.id}
          value={watch("avatar")}
          onChange={(url) => setValue("avatar", url, { shouldDirty: true, shouldValidate: true })}
          buttonLabel={t("settings_profile_upload")}
          hint={t("settings_profile_picture_hint")}
        />
        <Box sx={{ display: "grid", gap: 4, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
          <LabeledField
            id="profile-firstname"
            label={t("settings_profile_firstname")}
            required
            autoComplete="given-name"
            {...register("firstname")}
            error={card.errorOf("firstname")}
          />
          <LabeledField
            id="profile-lastname"
            label={t("settings_profile_lastname")}
            required
            autoComplete="family-name"
            {...register("lastname")}
            error={card.errorOf("lastname")}
          />
        </Box>
        <LabeledField
          id="profile-email"
          type="email"
          label={t("settings_profile_email")}
          required
          autoComplete="email"
          {...register("email")}
          error={card.errorOf("email")}
          help={t(
            email.trim() !== userProfile.email
              ? "settings_profile_email_changed_help"
              : "settings_profile_email_help"
          )}
        />
      </Stack>
      {pending && (
        <EmailChangeDialog
          email={pending.email}
          onCancel={() => setPending(null)}
          onConfirm={confirmEmailChange}
        />
      )}
    </SettingsCard>
  );
}
