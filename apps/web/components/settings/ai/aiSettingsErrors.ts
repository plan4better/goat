import type { TFunction } from "i18next";

import { AssistantApiError } from "@/lib/api/assistant";

/** Why members cannot use AI right now, for the reasons an admin can fix here. */
export const STATUS_MESSAGES: Record<string, string> = {
  no_connection: "ai_settings_status_no_connection",
  connection_not_allowed: "ai_settings_status_connection_not_allowed",
  credentials_unreadable: "ai_settings_status_credentials_unreadable",
};

/** The settings request failed: the fetcher attaches the service's answer as `info` and the HTTP status. */
export function loadErrorText(
  error: { status?: number; info?: { detail?: { code?: string } } },
  t: TFunction
): string {
  if (error.status === 403) {
    return t(
      error.info?.detail?.code === "no_organization"
        ? "ai_settings_error_no_organization"
        : "ai_settings_admin_only"
    );
  }
  return t("ai_settings_error_generic");
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

/** A failed request of the AI settings page or its connection dialog, as the text to show. Here rather than in
 * the dialog's module, so the page does not load the dialog's code before it opens. */
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
