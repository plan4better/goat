"use client";

import { useTranslation } from "react-i18next";

import PageHeader from "@/components/dashboard/common/PageHeader";
import SettingsPage from "@/components/settings/common/SettingsPage";
import PreferenceCards from "@/components/settings/preferences/PreferenceCards";

export default function PreferencesPage() {
  const { t } = useTranslation("common");
  return (
    <SettingsPage
      header={
        <PageHeader
          level={2}
          responsive
          eyebrow={t("settings_nav_group_account")}
          title={t("settings_prefs_title")}
          subtitle={t("settings_prefs_subtitle")}
        />
      }>
      <PreferenceCards />
    </SettingsPage>
  );
}
