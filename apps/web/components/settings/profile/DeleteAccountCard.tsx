"use client";

import { signOut } from "next-auth/react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { deleteAccount, useUserProfile } from "@/lib/api/users";

import { ConfirmLoadFailed, orLoadFailed } from "@/components/assistant/LoadFailed";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import DangerCard from "@/components/settings/common/DangerCard";
import SettingsCard from "@/components/settings/common/SettingsCard";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";

// Loaded on first open. A dialog whose code does not load (a deploy since the
// page opened) shows a notice instead of taking the page down.
const ConfirmModal = dynamic(() => orLoadFailed(import("@/components/modals/Confirm"), ConfirmLoadFailed), {
  ssr: false,
});

/**
 * Konto löschen. `DELETE /users` deletes only the Keycloak account (F11): the
 * copy says so. The organization's owner cannot (R1): the organization would
 * be left with nobody who can delete or hand it over. The button appears only
 * once the roles are known, so no click can open the dialog for an owner.
 */
export default function DeleteAccountCard() {
  const { t } = useTranslation("common");
  const { userProfile, isError, mutate } = useUserProfile();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = t("settings_profile_delete_title");

  if (!userProfile) {
    return isError ? (
      <SettingsCard title={title} tone="danger">
        <SettingsLoadError onRetry={() => void mutate()} />
      </SettingsCard>
    ) : (
      <CardSkeleton title={title} rows={1} variant="list" />
    );
  }

  const isOwner = !!userProfile.roles?.includes("organization-owner");

  // The dialog stays open, its button spinning, until core answers: signing
  // out then leaves the page; a failure leaves the dialog for another try.
  const remove = async () => {
    setBusy(true);
    try {
      await deleteAccount();
    } catch {
      setBusy(false);
      toast.error(t("settings_profile_delete_error"));
      return;
    }
    await signOut({ callbackUrl: process.env.NEXT_PUBLIC_APP_URL });
  };

  return (
    <>
      <DangerCard
        title={title}
        text={t("settings_profile_delete_text")}
        buttonLabel={t("settings_profile_delete_button")}
        onClick={() => setOpen(true)}
        disabledReason={isOwner ? t("settings_profile_delete_owner_reason") : undefined}
      />
      {open && !isOwner && (
        <ConfirmModal
          open
          title={title}
          body={t("settings_profile_delete_dialog_body")}
          matchText={userProfile.email}
          matchLabel={t("settings_profile_delete_match", {
            email: userProfile.email,
            interpolation: { escapeValue: false },
          })}
          confirmText={t("settings_profile_delete_confirm")}
          closeText={t("cancel")}
          loading={busy}
          onClose={() => setOpen(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
