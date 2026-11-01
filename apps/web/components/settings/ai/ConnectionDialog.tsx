"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, Checkbox, FormControlLabel, MenuItem, Stack, TextField } from "@mui/material";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";

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

/** The `<form>` the dialog footer's Save button submits through `primaryForm`. */
const FORM_ID = "assistant-connection-form";

export function providerLabel(provider: AssistantProvider, t: TFunction): string {
  return PROVIDER_NAMES[provider] ?? t("ai_settings_provider_openai_compatible");
}

/**
 * Error codes of the assistant's settings API, as translated messages. The `detail` strings the service adds
 * (invalid_connection, endpoint_not_allowed, invalid_request, test_failed, the last test error) are shown to
 * organization admins as they are, in English: they name the field or the provider's own answer.
 */
const ERROR_MESSAGES: Record<string, string> = {
  name_taken: "ai_settings_error_name_taken",
  endpoint_not_allowed: "ai_settings_error_endpoint_not_allowed",
  provider_not_allowed: "ai_settings_error_provider_not_allowed",
  org_connections_unavailable: "ai_settings_org_connections_off",
  connection_not_tested: "ai_settings_error_connection_not_tested",
  connection_not_allowed: "ai_settings_error_connection_not_allowed",
  connection_not_found: "ai_settings_error_connection_not_found",
  connection_changed: "ai_settings_error_connection_changed",
  connection_active: "ai_settings_delete_active_blocked",
  credentials_unreadable: "ai_settings_credentials_unreadable",
  credentials_required: "ai_settings_error_credentials_required",
  goat_ai_unavailable: "ai_settings_goat_ai_unavailable",
  test_in_progress: "ai_settings_error_test_in_progress",
  invalid_request: "ai_settings_error_invalid_request",
  not_found: "ai_settings_error_not_found",
  no_organization: "ai_settings_error_no_organization",
  not_admin: "ai_settings_admin_only",
};

export function assistantErrorText(error: unknown, t: TFunction): string {
  if (error instanceof AssistantApiError) {
    if (error.code === "test_failed")
      return t("ai_settings_error_test_failed", { message: error.detail ?? "" });
    const key = ERROR_MESSAGES[error.code];
    if (key) return error.detail ? `${t(key)} ${error.detail}` : t(key);
    if (error.code === "invalid_connection" && error.detail) return error.detail;
  }
  return t("ai_settings_error_generic");
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
  onSaved: () => Promise<unknown> | void;
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
    formState: { errors, isValid },
  } = useForm<ConnectionFormValues>({
    mode: "onChange",
    resolver: zodResolver(schema),
    defaultValues: connection ? toConnectionFormValues(connection) : emptyConnectionForm(firstProvider),
  });
  const [busy, setBusy] = useState(false);
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
  const fieldError = (name: keyof ConnectionFormValues) => {
    const message = errors[name]?.message;
    if (message) return t(message);
    return failure?.field === name ? failure.message : undefined;
  };
  // Typed secrets must not outlive the dialog: they would render for a frame on the next open.
  const close = () => {
    if (busy) return;
    reset(initialValues());
    setFailure(null);
    onClose();
  };

  const onSubmit = async (values: ConnectionFormValues) => {
    setBusy(true);
    setFailure(null);
    try {
      const payload = toConnectionPayload(values, mode);
      if (connection) await updateAssistantConnection(connection.id, payload);
      else await createAssistantConnection(payload);
      toast.success(t("ai_settings_connection_saved"));
      await onSaved();
      reset(initialValues());
      onClose();
    } catch (error) {
      setFailure({ message: assistantErrorText(error, t), field: assistantErrorField(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onClose={close}
      icon={ICON_NAME.SPARKLES}
      title={connection ? t("ai_settings_edit_connection") : t("ai_settings_add_connection")}
      maxWidth={600}
      closeDisabled={busy}
      notice={failure ? <Alert severity="error">{failure.message}</Alert> : undefined}
      footer={
        <AppDialogFooter
          onCancel={close}
          cancelDisabled={busy}
          primaryLabel={t("save")}
          onPrimary={handleSubmit(onSubmit)}
          primaryType="submit"
          primaryForm={FORM_ID}
          primaryDisabled={!isValid}
          primaryLoading={busy}
        />
      }>
      <Stack component="form" id={FORM_ID} onSubmit={handleSubmit(onSubmit)} spacing={4} sx={{ pt: 1 }}>
        <TextField
          required
          label={t("name")}
          disabled={busy}
          error={Boolean(fieldError("name"))}
          helperText={fieldError("name")}
          {...register("name")}
        />
        <Controller
          name="provider"
          control={control}
          render={({ field }) => (
            <TextField select required label={t("ai_settings_field_provider")} disabled={busy} {...field}>
              {providers.map((option) => (
                <MenuItem key={option} value={option}>
                  {providerLabel(option, t)}
                </MenuItem>
              ))}
            </TextField>
          )}
        />
        {fields.baseUrl && (
          <TextField
            required
            label={t("ai_settings_field_base_url")}
            placeholder="https://"
            disabled={busy}
            error={Boolean(fieldError("base_url"))}
            helperText={
              fieldError("base_url") ??
              t(
                provider === "azure_openai"
                  ? "ai_settings_field_base_url_help_azure"
                  : "ai_settings_field_base_url_help_compatible"
              )
            }
            {...register("base_url")}
          />
        )}
        {fields.region && (
          <TextField
            required
            label={t("ai_settings_field_region")}
            disabled={busy}
            error={Boolean(fieldError("region"))}
            helperText={
              fieldError("region") ??
              t(
                provider === "bedrock"
                  ? "ai_settings_field_region_help_bedrock"
                  : "ai_settings_field_region_help_vertex"
              )
            }
            {...register("region")}
          />
        )}
        <TextField
          required
          label={t("ai_settings_field_model")}
          disabled={busy}
          error={Boolean(fieldError("model"))}
          helperText={
            fieldError("model") ??
            t(fields.claudeOnly ? "ai_settings_claude_only_help" : "ai_settings_field_model_help")
          }
          {...register("model")}
        />
        {openRouter && (
          <>
            <TextField
              label={t("ai_settings_field_provider_order")}
              placeholder="DeepInfra"
              disabled={busy}
              error={Boolean(fieldError("provider_order"))}
              helperText={fieldError("provider_order") ?? t("ai_settings_field_provider_order_help")}
              {...register("provider_order")}
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
          <TextField
            type="password"
            autoComplete="new-password"
            required={!fields.optionalSecrets.includes("api_key") && !keepSecret}
            label={t("ai_settings_field_api_key")}
            disabled={busy}
            error={Boolean(fieldError("api_key"))}
            helperText={
              fieldError("api_key") ??
              keepHelp ??
              (fields.optionalSecrets.includes("api_key")
                ? t("ai_settings_field_api_key_optional_help")
                : undefined)
            }
            {...register("api_key")}
          />
        )}
        {fields.secrets.includes("access_key_id") && (
          <TextField
            autoComplete="off"
            required={!keepSecret}
            label={t("ai_settings_field_access_key_id")}
            disabled={busy}
            error={Boolean(fieldError("access_key_id"))}
            helperText={fieldError("access_key_id") ?? keepHelp}
            {...register("access_key_id")}
          />
        )}
        {fields.secrets.includes("secret_access_key") && (
          <TextField
            type="password"
            autoComplete="new-password"
            required={!keepSecret}
            label={t("ai_settings_field_secret_access_key")}
            disabled={busy}
            error={Boolean(fieldError("secret_access_key"))}
            helperText={fieldError("secret_access_key") ?? keepHelp}
            {...register("secret_access_key")}
          />
        )}
        {fields.secrets.includes("service_account_json") && (
          <TextField
            multiline
            minRows={4}
            autoComplete="off"
            required={!keepSecret}
            label={t("ai_settings_field_service_account_json")}
            disabled={busy}
            error={Boolean(fieldError("service_account_json"))}
            helperText={fieldError("service_account_json") ?? keepHelp}
            {...register("service_account_json")}
          />
        )}
      </Stack>
    </AppDialog>
  );
}
