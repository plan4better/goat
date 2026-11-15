"use client";

import { useTranslation } from "react-i18next";

import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsPage from "@/components/settings/common/SettingsPage";
import DeleteAccountCard from "@/components/settings/profile/DeleteAccountCard";
import PersonalCard from "@/components/settings/profile/PersonalCard";
import YourOrganizationCard from "@/components/settings/profile/YourOrganizationCard";

export default function ProfilePage() {
  const { t } = useTranslation("common");
  return (
    <SettingsPage
      header={
        <PageHeader
          level={2}
          responsive
          eyebrow={t("settings_nav_group_account")}
          title={t("settings_profile_title")}
          subtitle={t("settings_profile_subtitle")}
        />
      }>
      <PersonalCard />
      <YourOrganizationCard />
      <DeleteAccountCard />
    </SettingsPage>
  );
}
