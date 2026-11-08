"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MenuItem, Stack } from "@mui/material";
import { useState } from "react";
import { type FieldError, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { createOrganizationAnalytics, updateOrganizationAnalytics } from "@/lib/api/organizationAnalytics";
import {
  type OrganizationAnalytics,
  type OrganizationAnalyticsCreate,
  organizationAnalyticsCreateSchema,
} from "@/lib/validations/organizationAnalytics";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";

const FORM_ID = "settings-matomo-form";

/** "Matomo verbinden" or, with `instance`, "Matomo bearbeiten". The messages of
 * `organizationAnalyticsCreateSchema` are i18n keys; a field's shows once it
 * was left or a save was tried, not on the first keystroke. */
export default function MatomoDialog({
  organizationId,
  instance,
  onClose,
  onSaved,
}: {
  organizationId: string;
  instance: OrganizationAnalytics | null;
  onClose: () => void;
  /** Reads the instances (and their dashboards) again. */
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useTranslation("common");
  const config = (instance?.config ?? {}) as { url?: string; site_id?: string };
  const [tried, setTried] = useState(false);
  const {
    register,
    handleSubmit,
    trigger,
    formState: { errors, isValid, isSubmitting, touchedFields },
  } = useForm<OrganizationAnalyticsCreate>({
    mode: "onChange",
    resolver: zodResolver(organizationAnalyticsCreateSchema),
    defaultValues: {
      name: instance?.name ?? "",
      provider: "matomo",
      config: { provider: "matomo", url: config.url ?? "", site_id: config.site_id ?? "" },
    },
  });
  const shown = (error: FieldError | undefined, touched: boolean | undefined) =>
    error?.message && (touched || tried) ? t(error.message) : undefined;

  const submit = handleSubmit(async (values) => {
    try {
      if (instance) await updateOrganizationAnalytics(organizationId, instance.id, values);
      else await createOrganizationAnalytics(organizationId, values);
      await onSaved();
      toast.success(t("settings_analytics_saved"));
      onClose();
    } catch {
      toast.error(t("settings_analytics_save_error"));
    }
  });
  const attempt = () => {
    setTried(true);
    void submit();
  };
  // Locked while saving, read only and not disabled: react-hook-form reads a
  // disabled field as empty, and a blur meanwhile would store that.
  const lock = { readOnly: isSubmitting, "aria-readonly": isSubmitting || undefined };

  return (
    <AppDialog
      open
      onClose={onClose}
      icon={ICON_NAME.CHART}
      title={t(instance ? "settings_analytics_form_title_edit" : "settings_analytics_form_title_new")}
      subtitle={instance?.name}
      maxWidth={580}
      closeDisabled={isSubmitting}
      footer={
        <AppDialogFooter
          onCancel={onClose}
          cancelDisabled={isSubmitting}
          primaryLabel={t("save")}
          primaryType="submit"
          primaryForm={FORM_ID}
          onPrimary={attempt}
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
        onKeyDown={(event) => {
          // Enter in a field is a try, also while Speichern is disabled and the
          // browser therefore submits nothing: then it names what is missing.
          if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || isValid) return;
          setTried(true);
          void trigger();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          attempt();
        }}>
        <LabeledField
          id="matomo-name"
          label={t("settings_analytics_name")}
          required
          inputProps={lock}
          {...register("name")}
          error={shown(errors.name, touchedFields.name)}
          help={t("settings_analytics_name_help")}
        />
        <LabeledField
          id="matomo-provider"
          select
          label={t("settings_analytics_provider")}
          defaultValue="matomo"
          // Read only: the select does not open.
          inputProps={{ readOnly: isSubmitting }}
          SelectProps={{ SelectDisplayProps: { "aria-readonly": isSubmitting || undefined } }}
          {...register("provider")}
          help={t("settings_analytics_provider_help")}>
          <MenuItem value="matomo">Matomo</MenuItem>
        </LabeledField>
        <LabeledField
          id="matomo-url"
          label={t("settings_analytics_url")}
          required
          placeholder="https://matomo.example.org/"
          inputProps={{
            ...lock,
            style: { fontFamily: "monospace" },
            autoCapitalize: "off",
            spellCheck: false,
          }}
          {...register("config.url")}
          error={shown(errors.config?.url, touchedFields.config?.url)}
          help={t("settings_analytics_url_help")}
        />
        <LabeledField
          id="matomo-site-id"
          label={t("settings_analytics_site_id_label")}
          required
          inputProps={{ ...lock, inputMode: "numeric" }}
          {...register("config.site_id")}
          error={shown(errors.config?.site_id, touchedFields.config?.site_id)}
          help={t("settings_analytics_site_id_help")}
        />
      </Stack>
    </AppDialog>
  );
}
