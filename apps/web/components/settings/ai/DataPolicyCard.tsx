"use client";

import { useTranslation } from "react-i18next";

import type { DataPolicy } from "@/lib/validations/assistant";

import RadioCardGroup from "@/components/settings/common/RadioCardGroup";
import SettingsCard from "@/components/settings/common/SettingsCard";

const POLICIES: DataPolicy[] = ["standard", "restricted"];

/** Datenrichtlinie: what the assistant may send to the model, for every connection; a pick saves at once. */
export default function DataPolicyCard({
  value,
  disabled = false,
  onChange,
}: {
  value: DataPolicy;
  /** A change of the settings is being saved. */
  disabled?: boolean;
  onChange: (policy: DataPolicy) => void;
}) {
  const { t } = useTranslation("common");
  return (
    <SettingsCard title={t("settings_ai_policy_title")} hint={t("settings_ai_policy_hint")}>
      <RadioCardGroup<DataPolicy>
        label={t("settings_ai_policy_title")}
        value={value}
        columns={{ xs: 1, md: 2 }}
        onChange={(policy) => {
          if (policy !== value) onChange(policy);
        }}
        options={POLICIES.map((policy) => ({
          value: policy,
          label: t(`ai_settings_data_policy_${policy}`),
          line: t(`ai_settings_data_policy_${policy}_help`),
          disabled,
        }))}
      />
    </SettingsCard>
  );
}
