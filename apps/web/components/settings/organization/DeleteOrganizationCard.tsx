"use client";

import Cookies from "js-cookie";
import { signOut } from "next-auth/react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { deleteOrganization, useOrganizationMembers } from "@/lib/api/organizations";
import { useOrganization } from "@/lib/api/users";

import { ORGANIZATION_COOKIE, useOrganizationId } from "@/hooks/settings/useOrganizationId";

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
 * Organisation löschen, for the owner only (decision 3; core refuses admins
 * already, F1). Core suspends the organization (F12), so the copy says access
 * ends, not that data is destroyed. The button appears only once the
 * organization is there, so no click before it can open the dialog later.
 */
export default function DeleteOrganizationCard({ owner }: { owner: boolean }) {
  const { t } = useTranslation("common");
  const { organization, isError, mutate } = useOrganization();
  const organizationId = useOrganizationId();
  const { members } = useOrganizationMembers(organizationId ?? "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = t("settings_org_delete_title");

  if (!organization) {
    return isError ? (
      <SettingsCard title={title} tone="danger">
        <SettingsLoadError onRetry={() => void mutate()} />
      </SettingsCard>
    ) : (
      <CardSkeleton title={title} rows={1} variant="list" />
    );
  }

  // Unknown while the members load or after they failed: the dialog then names no number.
  const count = members?.filter((member) => member.invitation_status !== "pending").length;

  // The dialog stays open, its button spinning, until core answers: signing
  // out then leaves the page; a failure leaves the dialog for another try.
  const remove = async () => {
    setBusy(true);
    try {
      await deleteOrganization(organization.id);
    } catch {
      setBusy(false);
      toast.error(t("settings_org_delete_error"));
      return;
    }
    Cookies.remove(ORGANIZATION_COOKIE);
    await signOut({ callbackUrl: process.env.NEXT_PUBLIC_APP_URL });
  };

  return (
    <>
      <DangerCard
        title={title}
        text={t("settings_org_delete_text")}
        buttonLabel={t("settings_org_delete_button")}
        onClick={() => setOpen(true)}
        disabledReason={owner ? undefined : t("settings_org_delete_owner_only")}
      />
      {open && owner && (
        <ConfirmModal
          open
          title={title}
          body={
            <>
              <p>{t("settings_org_delete_intro")}</p>
              <ul>
                {count !== undefined && <li>{t("settings_org_delete_point_members", { count })}</li>}
                <li>{t("settings_org_delete_point_content")}</li>
                <li>{t("settings_org_delete_point_signout")}</li>
              </ul>
            </>
          }
          matchText={organization.name}
          matchLabel={t("settings_org_delete_match", {
            name: organization.name,
            interpolation: { escapeValue: false },
          })}
          confirmText={t("settings_org_delete_confirm")}
          closeText={t("cancel")}
          loading={busy}
          onClose={() => setOpen(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
