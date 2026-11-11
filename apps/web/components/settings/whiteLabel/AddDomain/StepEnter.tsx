"use client";

import { Stack, Typography } from "@mui/material";
import type { FieldErrors, UseFormRegister } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { type CustomDomainCreate, isApexDomain } from "@/lib/validations/customDomain";

import LabeledField from "@/components/common/LabeledField";

/** Step 1, "Domain": the address, checked by `customDomainCreateSchema`
 * (its messages are i18n keys). The footer's "Weiter" submits this form; the
 * dialog decides when `errors` are shown. */
export function StepEnter({
  formId,
  register,
  errors,
  value,
  onSubmit,
  onAttempt,
}: {
  formId: string;
  register: UseFormRegister<CustomDomainCreate>;
  errors: FieldErrors<CustomDomainCreate>;
  /** What is typed, for the main domain hint. */
  value: string;
  onSubmit: () => void;
  /** Enter in the field: a try to go on, also while "Weiter" is disabled and
   * the browser therefore submits nothing. */
  onAttempt: () => void;
}) {
  const { t } = useTranslation("common");
  const typed = value.trim().toLowerCase();
  const apex = typed.includes(".") && isApexDomain(typed);
  const error = errors.base_domain?.message;
  return (
    <Stack
      component="form"
      id={formId}
      spacing={4}
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Enter") onAttempt();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}>
      <Typography variant="body2" color="text.secondary">
        {t("settings_domains_enter_text")}
      </Typography>
      <LabeledField
        id="add-domain-name"
        label={t("settings_domains_name")}
        required
        autoFocus
        placeholder={t("settings_domains_name_placeholder")}
        {...register("base_domain")}
        error={error ? t(error) : undefined}
        help={t(apex ? "settings_domains_name_apex_help" : "settings_domains_name_help")}
        inputProps={{ style: { fontFamily: "monospace" }, autoCapitalize: "off", spellCheck: false }}
      />
    </Stack>
  );
}
