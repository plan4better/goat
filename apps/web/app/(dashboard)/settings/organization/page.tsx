"use client";

import { Skeleton } from "@mui/material";
import { useTranslation } from "react-i18next";

import { useUserProfile } from "@/lib/api/users";

import PageHeader from "@/components/dashboard/common/PageHeader";
import CardSkeleton from "@/components/settings/common/CardSkeleton";
import SettingsLoadError from "@/components/settings/common/SettingsLoadError";
import SettingsPage from "@/components/settings/common/SettingsPage";
import { orgRoleOf } from "@/components/settings/common/roleWords";
import { isOrgAdminRole } from "@/components/settings/nav/settingsNav";
import AdminsCard from "@/components/settings/organization/AdminsCard";
import DeleteOrganizationCard from "@/components/settings/organization/DeleteOrganizationCard";
import NameLogoCard from "@/components/settings/organization/NameLogoCard";
import OrgSummaryCard from "@/components/settings/organization/OrgSummaryCard";

/** Organisation › Profil: editable for owners and admins, read-only for Bearbeiter and Betrachter. */
export default function OrganizationProfilePage() {
  const { t } = useTranslation("common");
  const { userProfile, isError, mutate } = useUserProfile();
  const roles = userProfile?.roles;
  const known = roles !== undefined;
  const failed = !known && !!isError;
  const admin = isOrgAdminRole(roles);

  return (
    <SettingsPage
      header={
        <PageHeader
          level={2}
          responsive
          eyebrow={t("settings_nav_group_organization")}
          title={t("settings_org_title")}
          subtitle={
            known ? (
              t(admin ? "settings_org_subtitle_admin" : "settings_org_subtitle_member")
            ) : failed ? undefined : (
              <Skeleton variant="text" width={360} sx={{ maxWidth: "100%" }} />
            )
          }
        />
      }>
      {failed ? (
        // The role decides which cards stand here and what the contacts card
        // says; until the profile is read, its retry stands for both.
        <SettingsLoadError onRetry={() => void mutate()} />
      ) : !known ? (
        <CardSkeleton
          title={t("settings_org_name_logo_title")}
          hint={<Skeleton variant="text" width={320} sx={{ maxWidth: "100%" }} />}
          rows={2}
          help
          footer
        />
      ) : admin ? (
        <NameLogoCard />
      ) : (
        <OrgSummaryCard role={orgRoleOf(roles)} />
      )}
      {!failed && <AdminsCard admin={known ? admin : undefined} />}
      {admin && <DeleteOrganizationCard owner={!!roles?.includes("organization-owner")} />}
    </SettingsPage>
  );
}
