"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, Checkbox, FormControlLabel, MenuItem, Stack } from "@mui/material";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import { AssistantApiError, createAssistantConnection, updateAssistantConnection } from "@/lib/api/assistant";
import {
  type AssistantConnection,
  type AssistantProvider,
  type ConnectionFormValues,
  PROVIDER_FIELDS,
  PROVIDER_NAMES,
  connectionFormSchema,
  emptyConnectionForm,
  isOpenRouterUrl,
  toConnectionFormValues,
  toConnectionPayload,
} from "@/lib/validations/assistant";

import AppDialog, { AppDialogFooter } from "@/components/common/AppDialog";
import LabeledField from "@/components/common/LabeledField";
import { assistantErrorText } from "@/components/settings/ai/aiSettingsErrors";

export { assistantErrorText };

/** The `<form>` the dialog footer's primary button submits through `primaryForm`. */
const FORM_ID = "assistant-connection-form";

export function providerLabel(provider: AssistantProvider, t: TFunction): string {
  return PROVIDER_NAMES[provider] ?? t("ai_settings_provider_openai_compatible");
}

const FORM_FIELDS = Object.keys(emptyConnectionForm("openai")) as (keyof ConnectionFormValues)[];

/** The form field an API error belongs to: the one the service names, else the base URL for a refused address. */
export function assistantErrorField(error: unknown): keyof ConnectionFormValues | undefined {
  if (!(error instanceof AssistantApiError)) return undefined;
  const named = FORM_FIELDS.find((field) => field === error.field);
  if (named) return named;
  return error.code === "endpoint_not_allowed" ? "base_url" : undefined;
}

interface ConnectionDialogProps {
  open: boolean;
  /** null: add a connection. */
  connection: AssistantConnection | null;
  allowedProviders: AssistantProvider[];
  allowHttp: boolean;
  onClose: () => void;
  /** The connection as the service stored it; the page tests it next ("Speichern und testen"). */
  onSaved: (connection: AssistantConnection) => Promise<unknown> | void;
}

export default function ConnectionDialog({
  open,
  connection,
  allowedProviders,
  allowHttp,
  onClose,
  onSaved,
}: ConnectionDialogProps) {
  const { t } = useTranslation("common");
  const mode = connection ? "edit" : "create";
  // An existing connection keeps its provider in the list even if the instance no longer offers it.
  const providers =
    connection && !allowedProviders.includes(connection.provider)
      ? [connection.provider, ...allowedProviders]
      : allowedProviders;
  const firstProvider = providers[0] ?? "openai_compatible";
  const schema = useMemo(
    () => connectionFormSchema({ mode, allowHttp, originalProvider: connection?.provider }),
    [mode, allowHttp, connection?.provider]
  );
  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    trigger,
    formState: { errors, isValid, touchedFields },
  } = useForm<ConnectionFormValues>({
    mode: "onChange",
    resolver: zodResolver(schema),
    defaultValues: connection ? toConnectionFormValues(connection) : emptyConnectionForm(firstProvider),
  });
  const [busy, setBusy] = useState(false);
  // A save was tried (the button or Enter): every field's error shows, not only the ones left.
  const [tried, setTried] = useState(false);
  // The last failed save, shown inside the dialog: a toast is outside the modal, hidden from assistive
  // technology and easy to miss while the dialog stays open.
  const [failure, setFailure] = useState<{ message: string; field?: keyof ConnectionFormValues } | null>(
    null
  );

  const initialValues = () =>
    connection ? toConnectionFormValues(connection) : emptyConnectionForm(firstProvider);

  useEffect(() => {
    if (open) {
      reset(initialValues());
      setFailure(null);
      setTried(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection, firstProvider, reset]);

  // Editing a field answers the failure: the message no longer describes what is in the form.
  useEffect(() => {
    const subscription = watch(() => setFailure(null));
    return () => subscription.unsubscribe();
  }, [watch]);

  const provider = watch("provider");
  const fields = PROVIDER_FIELDS[provider];
  // OpenRouter sends one model to many providers; only its connections can name them.
  const openRouter = fields.baseUrl && isOpenRouterUrl(watch("base_url"));
  const keepSecret = mode === "edit" && provider === connection?.provider;
  const keepHelp = keepSecret ? t("ai_settings_field_keep_secret") : undefined;
  // A field's own error once it was left or a save was tried, not on the first keystroke; the service's
  // answer for a field at once (it comes from a save).
  const fieldError = (name: keyof ConnectionFormValues) => {
    const message = errors[name]?.message;
    if (message && (touchedFields[name] || tried)) return t(message);
    return failure?.field === name ? failure.message : undefined;
  };
  // Locked while saving, read only and not disabled: react-hook-form reads a disabled field as empty, and
  // a blur meanwhile would store that.
  const lock = { readOnly: busy, "aria-readonly": busy || undefined };
  // Typed secrets must not outlive the dialog: they would render for a frame on the next open.
  const close = () => {
    if (busy) return;
    reset(initialValues());
    setFailure(null);
    setTried(false);
    onClose();
  };

  const onSubmit = async (values: ConnectionFormValues) => {
    setBusy(true);
    setFailure(null);
    try {
      const payload = toConnectionPayload(values, mode);
      const saved = connection
        ? await updateAssistantConnection(connection.id, payload)
        : await createAssistantConnection(payload);
      await onSaved(saved);
      reset(initialValues());
      setTried(false);
      onClose();
    } catch (error) {
      setFailure({ message: assistantErrorText(error, t), field: assistantErrorField(error) });
    } finally {
      setBusy(false);
    }
  };
  const attempt = () => {
    setTried(true);
    void handleSubmit(onSubmit)();
  };
  return (
    <AppDialog
      open={open}
      onClose={close}
      icon={ICON_NAME.SPARKLES}
      title={t(connection ? "ai_settings_edit_connection" : "settings_ai_dialog_add_title")}
      subtitle={connection ? undefined : t("settings_ai_dialog_add_subtitle")}
      maxWidth={600}
      closeDisabled={busy}
      notice={failure ? <Alert severity="error">{failure.message}</Alert> : undefined}
      footer={
        <AppDialogFooter
          onCancel={close}
          cancelDisabled={busy}
          primaryLabel={t("settings_ai_save_and_test")}
          onPrimary={attempt}
          primaryType="submit"
          primaryForm={FORM_ID}
          primaryDisabled={!isValid}
          primaryLoading={busy}
        />
      }>
      <Stack
        component="form"
        id={FORM_ID}
        noValidate
        spacing={5}
        sx={{ pt: 1 }}
        onKeyDown={(event) => {
          // Enter in a field is a try, also while the primary is disabled and the browser therefore submits
          // nothing: then it names what is missing.
          if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || isValid) return;
          setTried(true);
          void trigger();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) attempt();
        }}>
        <LabeledField
          id="connection-name"
          required
          label={t("name")}
          inputProps={lock}
          {...register("name")}
          error={fieldError("name")}
        />
        <Controller
          name="provider"
          control={control}
          render={({ field }) => (
            <LabeledField
              id="connection-provider"
              select
              required
              label={t("ai_settings_field_provider")}
              {...field}
              // Read only while saving: the select does not open.
              inputProps={{ readOnly: busy }}
              SelectProps={{ SelectDisplayProps: { "aria-readonly": busy || undefined } }}>
              {providers.map((option) => (
                <MenuItem key={option} value={option}>
                  {providerLabel(option, t)}
                </MenuItem>
              ))}
            </LabeledField>
          )}
        />
        {fields.baseUrl && (
          <LabeledField
            id="connection-base-url"
            required
            label={t("ai_settings_field_base_url")}
            placeholder="https://"
            inputProps={{ ...lock, autoCapitalize: "off", spellCheck: false }}
            {...register("base_url")}
            error={fieldError("base_url")}
            help={t(
              provider === "azure_openai"
                ? "ai_settings_field_base_url_help_azure"
                : "ai_settings_field_base_url_help_compatible"
            )}
          />
        )}
        {fields.region && (
          <LabeledField
            id="connection-region"
            required
            label={t("ai_settings_field_region")}
            inputProps={lock}
            {...register("region")}
            error={fieldError("region")}
            help={t(
              provider === "bedrock"
                ? "ai_settings_field_region_help_bedrock"
                : "ai_settings_field_region_help_vertex"
            )}
          />
        )}
        <LabeledField
          id="connection-model"
          required
          label={t("ai_settings_field_model")}
          inputProps={{ ...lock, autoCapitalize: "off", spellCheck: false }}
          {...register("model")}
          error={fieldError("model")}
          help={t(fields.claudeOnly ? "ai_settings_claude_only_help" : "ai_settings_field_model_help")}
        />
        {openRouter && (
          <>
            <LabeledField
              id="connection-provider-order"
              label={t("ai_settings_field_provider_order")}
              placeholder="DeepInfra"
              inputProps={lock}
              {...register("provider_order")}
              error={fieldError("provider_order")}
              help={t("ai_settings_field_provider_order_help")}
            />
            <Controller
              name="allow_fallbacks"
              control={control}
              render={({ field }) => (
                <FormControlLabel
                  label={t("ai_settings_field_allow_fallbacks")}
                  disabled={busy}
                  control={
                    <Checkbox
                      checked={field.value}
                      onChange={(event) => field.onChange(event.target.checked)}
                      onBlur={field.onBlur}
                    />
                  }
                />
              )}
            />
          </>
        )}
        {fields.secrets.includes("api_key") && (
          <LabeledField
            id="connection-api-key"
            type="password"
            autoComplete="new-password"
            required={!fields.optionalSecrets.includes("api_key") && !keepSecret}
            label={t("ai_settings_field_api_key")}
            inputProps={lock}
            {...register("api_key")}
            error={fieldError("api_key")}
            help={
              keepHelp ??
              (fields.optionalSecrets.includes("api_key")
                ? t("ai_settings_field_api_key_optional_help")
                : undefined)
            }
          />
        )}
        {fields.secrets.includes("access_key_id") && (
          <LabeledField
            id="connection-access-key-id"
            autoComplete="off"
            required={!keepSecret}
            label={t("ai_settings_field_access_key_id")}
            inputProps={lock}
            {...register("access_key_id")}
            error={fieldError("access_key_id")}
            help={keepHelp}
          />
        )}
        {fields.secrets.includes("secret_access_key") && (
          <LabeledField
            id="connection-secret-access-key"
            type="password"
            autoComplete="new-password"
            required={!keepSecret}
            label={t("ai_settings_field_secret_access_key")}
            inputProps={lock}
            {...register("secret_access_key")}
            error={fieldError("secret_access_key")}
            help={keepHelp}
          />
        )}
        {fields.secrets.includes("service_account_json") && (
          <LabeledField
            id="connection-service-account-json"
            multiline
            minRows={4}
            autoComplete="off"
            required={!keepSecret}
            label={t("ai_settings_field_service_account_json")}
            inputProps={lock}
            {...register("service_account_json")}
            error={fieldError("service_account_json")}
            help={keepHelp}
          />
        )}
      </Stack>
    </AppDialog>
  );
}
