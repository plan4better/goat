import { RUN_ERROR_CODES, type RunStatusData } from "@/lib/assistant/types";

/**
 * An error answer of the assistant service; `code` is `detail.code`.
 * Defined here and re-exported by `lib/api/assistant`, so that module can build
 * on the request helpers without an import cycle.
 */
export class AssistantApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
    /** The request field the service blames, when it names one. */
    public readonly field?: string
  ) {
    super(detail ?? code);
  }
}

/** A refusal of the assistant service, with what the dock needs to explain it. */
export class AssistantRequestError extends AssistantApiError {
  readonly reason?: string;
  readonly projectId?: string;

  constructor(
    status: number,
    code: string,
    detail?: string,
    options: { reason?: string; projectId?: string; field?: string } = {}
  ) {
    super(status, code, detail, options.field);
    this.reason = options.reason;
    this.projectId = options.projectId;
  }
}

type Detail = { code?: unknown; message?: unknown; reason?: unknown; project_id?: unknown; field?: unknown };

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** `{"detail": {"code", "message", "reason"?, "project_id"?, "field"?}}`, or a generic code. */
export function errorFromBody(status: number, body: string | undefined): AssistantRequestError {
  let detail: Detail | undefined;
  try {
    const parsed = body ? (JSON.parse(body) as { detail?: unknown }) : undefined;
    if (
      parsed &&
      typeof parsed.detail === "object" &&
      parsed.detail !== null &&
      !Array.isArray(parsed.detail)
    ) {
      detail = parsed.detail as Detail;
    }
  } catch {
    // not JSON: keep the generic code
  }
  return new AssistantRequestError(status, text(detail?.code) ?? "request_failed", text(detail?.message), {
    reason: text(detail?.reason),
    projectId: text(detail?.project_id),
    field: text(detail?.field),
  });
}

export async function readAssistantError(response: Response): Promise<AssistantRequestError> {
  const body = await response.text().catch(() => "");
  return errorFromBody(response.status, body);
}

/**
 * The refusal behind an error, if there is one: our own requests throw
 * AssistantRequestError, the AI SDK throws APICallError (`statusCode`,
 * `responseBody`) when a run request is refused.
 */
export function toRequestError(error: unknown): AssistantRequestError | null {
  if (error instanceof AssistantRequestError) return error;
  if (error instanceof AssistantApiError)
    return new AssistantRequestError(error.status, error.code, error.detail, { field: error.field });
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const { statusCode, responseBody } = error as { statusCode?: unknown; responseBody?: unknown };
    if (typeof statusCode === "number") {
      return errorFromBody(statusCode, typeof responseBody === "string" ? responseBody : undefined);
    }
  }
  return null;
}

const CODE_KEYS: Record<string, string> = {
  conversation_busy: "assistant_error_conversation_busy",
  user_run_limit: "assistant_error_user_run_limit",
  shutting_down: "assistant_error_shutting_down",
  conversation_not_found: "assistant_error_conversation_not_found",
  run_not_found: "assistant_error_conversation_not_found",
  surface_disabled: "assistant_error_surface_disabled",
  invalid_context: "assistant_error_invalid_context",
  login_failed: "assistant_error_login_failed",
  project_access_lost: "assistant_error_project_access_lost",
  project_not_readable: "assistant_error_project_not_readable",
  conversation_bound: "assistant_error_conversation_bound",
  // Plan 2's handler for every request FastAPI refuses (D21).
  invalid_request: "assistant_error_invalid_request",
  // The dock's Undo of an answer's workflow edits.
  undo_not_allowed: "assistant_error_undo_not_allowed",
  undo_unavailable: "assistant_error_undo_unavailable",
  run_active: "assistant_error_undo_running",
  nothing_to_undo: "assistant_error_nothing_to_undo",
};

const UNAVAILABLE_KEYS: Record<string, string> = {
  disabled: "assistant_error_ai_disabled",
  no_organization: "assistant_error_no_organization",
};

/** The i18n key that explains an error in the UI language. */
export function assistantErrorKey(error: unknown): string {
  const refused = toRequestError(error);
  if (refused) {
    if (refused.code === "ai_unavailable") {
      return UNAVAILABLE_KEYS[refused.reason ?? ""] ?? "assistant_error_ai_unavailable";
    }
    if (CODE_KEYS[refused.code]) return CODE_KEYS[refused.code];
    if (refused.status === 401) return "assistant_error_login_failed";
    return "assistant_error_generic";
  }
  // fetch() rejects with a TypeError when the service cannot be reached.
  if (error instanceof TypeError) return "assistant_error_offline";
  return "assistant_error_generic";
}

/** The i18n key for how a run ended (the `data-run-status` part). */
export function runStatusKey(data: RunStatusData): string {
  if (data.status === "cancelled") return "assistant_run_cancelled";
  if (data.status === "interrupted") return "assistant_run_interrupted";
  return data.code && (RUN_ERROR_CODES as readonly string[]).includes(data.code)
    ? `assistant_run_error_${data.code}`
    : "assistant_run_error_unknown";
}
